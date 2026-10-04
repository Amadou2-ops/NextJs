-- =============================================================================
-- AML (0022) : évaluation obligatoire avant paiement, levée humaine des
-- alertes bloquantes, client gelé, listes versionnées, recherche de noms.
-- =============================================================================
DO $$
DECLARE
    v_alice         uuid := pg_temp.id('alice');
    v_admin         uuid;
    v_granter       uuid;
    v_recipient     uuid;
    v_quote         uuid;
    v_transfer      uuid;
    v_alert         uuid;
    v_version       bigint;
    v_entry         bigint;
    v_rate          numeric := round(655.957 * 9850 / 10000.0, 15);
BEGIN
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
    VALUES ('analyste-aml@transfertplus.example', 'Analyste AML', 'active', '$argon2id$v=19$test')
    RETURNING id INTO v_admin;
    -- Habilitation exigée en base pour clore une alerte (0023).
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
    VALUES ('responsable-aml@transfertplus.example', 'Responsable AML', 'active', '$argon2id$v=19$test')
    RETURNING id INTO v_granter;
    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id)
    VALUES (v_admin, 'risk_manager', v_granter);

    INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc, account_details_enc,
                                      account_details_bidx, display_hint, mobile_operator, pii_key_id)
    VALUES (v_alice, 'SN', 'XOF', 'mobile_money', '\x01', '\x02', sha256('221779990000'), '•••• 0000', 'wave', 'kms-key-v1')
    RETURNING id INTO v_recipient;
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                           funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                           margin_bps, usd_equivalent, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299,
            fx.convert_minor(10000, v_rate, 'EUR', 'XOF'), 655.957, v_rate, 150, 10800, now() + interval '10 minutes')
    RETURNING id INTO v_quote;
    INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency,
                                     destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                                     customer_rate, usd_equivalent, funding_method, payout_method, purpose_code,
                                     idempotency_key, authorization_method, authorized_at)
    SELECT q.user_id, v_recipient, q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency,
           q.source_amount, q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate, q.usd_equivalent,
           q.funding_method, q.payout_method, 'family_support', 'idem-key-aml-000001', 'totp', now()
      FROM fx.quotes q WHERE q.id = v_quote
    RETURNING id INTO v_transfer;
    PERFORM ledger.post_journal(
        'transfer:' || v_transfer || ':funding', 'transfer_hold',
        jsonb_build_array(pg_temp.line(pg_temp.id('alice_wallet_eur'), 'debit', 10299, 'EUR'),
                          pg_temp.line(pg_temp.id('alice_hold_eur'), 'credit', 10299, 'EUR')),
        'Réservation', 'customer:alice');
    UPDATE transfers.transfers SET status = 'funded' WHERE id = v_transfer;

    -- Mise en revue sans évaluation « review » : refusée.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'compliance_review' WHERE id = %L$q$, v_transfer),
        'TR001', 'mise en revue sans évaluation refusée');
    INSERT INTO aml.transfer_evaluations (transfer_id, outcome, rule_results, risk_score)
    VALUES (v_transfer, 'review', '[{"rule":"SINGLE_LARGE_TRANSFER","triggered":true}]', 80);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.transfer_evaluations SET outcome = 'clear' WHERE transfer_id = %L$q$, v_transfer),
        'LG006', 'évaluation immuable');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = %L$q$, v_transfer),
        'TR001', 'évaluation « review » : paiement direct refusé');
    UPDATE transfers.transfers SET status = 'compliance_review' WHERE id = v_transfer;

    INSERT INTO aml.alerts (user_id, transfer_id, rule_code, severity, score, details)
    VALUES (v_alice, v_transfer, 'SINGLE_LARGE_TRANSFER', 'high', 75, '{}')
    RETURNING id INTO v_alert;

    -- Sortie de revue par le système : refusée (décision humaine, 0023).
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = %L$q$, v_transfer),
        'BO002', 'libération automatique refusée');
    -- Alerte bloquante ouverte : sortie de revue vers le paiement refusée, même par un analyste.
    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_admin::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = %L$q$, v_transfer),
        'TR001', 'alerte bloquante ouverte : paiement refusé');
    PERFORM set_config('app.actor_type', '', true);

    -- Clôture par le système : refusée ; par un analyste identifié : acceptée.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.alerts SET status = 'closed_false_positive', resolved_by_admin_id = %L,
                  resolution_note = 'Montant justifié par pièces' WHERE id = %L$q$, v_admin, v_alert),
        'LG007', 'clôture automatique refusée');
    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_admin::text, true);
    UPDATE aml.alerts SET status = 'closed_false_positive', resolved_by_admin_id = v_admin,
                          resolution_note = 'Montant justifié par pièces' WHERE id = v_alert;
    UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = v_transfer;
    PERFORM pg_temp.assert_true((SELECT status = 'payout_pending' FROM transfers.transfers WHERE id = v_transfer),
        'transfert libéré après levée humaine');
    PERFORM set_config('app.actor_type', '', true);

    -- Client gelé : plus aucun transfert.
    INSERT INTO aml.customer_risk_profiles (user_id, risk_level, risk_score, is_sanctioned)
    VALUES (v_alice, 'unacceptable', 100, true);
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                           funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                           margin_bps, usd_equivalent, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299,
            fx.convert_minor(10000, v_rate, 'EUR', 'XOF'), 655.957, v_rate, 150, 10800, now() + interval '10 minutes')
    RETURNING id INTO v_quote;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency,
                destination_currency, source_amount, fee_amount, total_debit, destination_amount, customer_rate, usd_equivalent,
                funding_method, payout_method, purpose_code, idempotency_key, authorization_method, authorized_at)
           SELECT q.user_id, %L, q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency,
                  q.source_amount, q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate, q.usd_equivalent,
                  q.funding_method, q.payout_method, 'family_support', 'idem-key-aml-000002', 'totp', now()
             FROM fx.quotes q WHERE q.id = %L$q$, v_recipient, v_quote),
        'AM001', 'client gelé : transfert refusé');

    -- Listes versionnées et recherche approximative.
    INSERT INTO aml.list_versions (source, kind, version, content_sha256, entry_count, is_current)
    VALUES ('ofac_sdn', 'sanctions', '2026-10-01', sha256('liste-test'), 1, true)
    RETURNING id INTO v_version;
    INSERT INTO aml.list_entries (list_version_id, external_id, entry_type, primary_name, birth_dates)
    VALUES (v_version, '36', 'individual', 'OUSMANE, Amadou Karim', ARRAY['1971'])
    RETURNING id INTO v_entry;
    INSERT INTO aml.list_entry_names (entry_id, list_version_id, name, normalized)
    VALUES (v_entry, v_version, 'OUSMANE, Amadou Karim', 'amadou karim ousmane');
    PERFORM pg_temp.assert_true(
        (SELECT count(*) = 1 FROM aml.candidate_names('amadou karim ousman', 0.3, 10)),
        'variante orthographique retrouvée');
    PERFORM pg_temp.assert_true(
        (SELECT count(*) = 0 FROM aml.candidate_names('fatou ndiaye', 0.3, 10)),
        'nom sans rapport écarté');
    PERFORM pg_temp.assert_error(
        format($q$UPDATE aml.list_entries SET primary_name = 'X' WHERE id = %s$q$, v_entry),
        'LG006', 'entrée de liste immuable');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO aml.list_versions (source, kind, version, content_sha256, entry_count, is_current)
           VALUES ('ofac_sdn', 'sanctions', '2026-10-02', sha256('autre'), 1, true)$q$,
        '23505', 'une seule version courante par source');
END;
$$;
