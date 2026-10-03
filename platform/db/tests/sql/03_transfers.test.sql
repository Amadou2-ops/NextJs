-- =============================================================================
-- Devis et transferts : cohérence arithmétique, consommation unique, machine
-- à états, historisation.
-- =============================================================================
DO $$
DECLARE
    v_alice         uuid := pg_temp.id('alice');
    v_bob           uuid := pg_temp.id('bob');
    v_recipient     uuid;
    v_quote         uuid;
    v_quote2        uuid;
    v_transfer      uuid;
    v_history       text[];
    v_mid           numeric := 655.957;
    v_customer_rate numeric := round(655.957 * (10000 - 150)::numeric / 10000, 15);
    v_corridor      uuid;
    v_attempt       uuid;
    v_journal       uuid;
    v_big_quote     uuid;
    v_bob_recipient uuid;
BEGIN
    -- Conversion : 100,00 EUR à 646,117645 = 64611 XOF (arrondi vers le bas).
    PERFORM pg_temp.assert_true(fx.convert_minor(10000, v_customer_rate, 'EUR', 'XOF') = 64611,
        'conversion EUR → XOF arrondie vers le bas');
    PERFORM pg_temp.assert_true(fx.convert_minor(64611, 1 / v_mid, 'XOF', 'EUR') = 9849,
        'conversion XOF → EUR arrondie vers le bas');

    INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc,
                                      account_details_enc, account_details_bidx, display_hint,
                                      mobile_operator, pii_key_id)
    VALUES (v_alice, 'SN', 'XOF', 'mobile_money', '\x01', '\x02', sha256('221770000000'), '•••• 0000',
            'orange_money', 'kms-key-v1')
    RETURNING id INTO v_recipient;

    -- Devis incohérent (montant reçu gonflé de 1 XOF) : refusé.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                margin_bps, usd_equivalent, expires_at)
           VALUES (%L, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299, 64612, %s, %s, 150, 10800,
                   now() + interval '10 minutes')$q$, v_alice, v_mid, v_customer_rate),
        'LG007', 'devis avec montant reçu incohérent refusé');

    -- Devis dont le taux client ne découle pas de la marge : refusé.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                margin_bps, usd_equivalent, expires_at)
           VALUES (%L, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299, 65000, %s, 650, 150, 10800,
                   now() + interval '10 minutes')$q$, v_alice, v_mid),
        'LG007', 'taux client incohérent avec la marge refusé');

    -- Devis cohérent.
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                           payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate,
                           customer_rate, margin_bps, usd_equivalent, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299, 64611, v_mid,
            v_customer_rate, 150, 10800, now() + interval '10 minutes')
    RETURNING id INTO v_quote;

    -- Transfert dont le montant diffère du devis : refusé.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           VALUES (%L, %L, %L, 'FR', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 70000, %s, 10800, 'wallet_balance',
                   'mobile_money', 'family_support', 'idem-key-0000000001', 'totp', now())$q$,
        v_alice, v_recipient, v_quote, v_customer_rate),
        'TR002', 'transfert ne respectant pas le devis refusé');

    -- Transfert par un autre client avec le devis d'Alice : refusé.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           VALUES (%L, %L, %L, 'FR', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 64611, %s, 10800, 'wallet_balance',
                   'mobile_money', 'family_support', 'idem-key-0000000002', 'totp', now())$q$,
        v_bob, v_recipient, v_quote, v_customer_rate),
        'TR002', 'devis d''un autre client refusé');

    -- Transfert valide : consomme le devis.
    PERFORM set_config('app.actor_type', 'customer', true);
    PERFORM set_config('app.actor_id', v_alice::text, true);
    INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                                     source_currency, destination_currency, source_amount, fee_amount, total_debit,
                                     destination_amount, customer_rate, usd_equivalent, funding_method, payout_method,
                                     purpose_code, idempotency_key, authorization_method, authorized_at)
    VALUES (v_alice, v_recipient, v_quote, 'FR', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 64611, v_customer_rate,
            10800, 'wallet_balance', 'mobile_money', 'family_support', 'idem-key-0000000003', 'totp', now())
    RETURNING id INTO v_transfer;

    PERFORM pg_temp.assert_true(
        (SELECT consumed_by_transfer_id FROM fx.quotes WHERE id = v_quote) = v_transfer,
        'devis consommé par le transfert');
    PERFORM pg_temp.assert_true(
        (SELECT reference ~ '^TP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$' FROM transfers.transfers WHERE id = v_transfer),
        'référence lisible générée');

    -- Réutilisation du devis : refusée.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           VALUES (%L, %L, %L, 'FR', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 64611, %s, 10800, 'wallet_balance',
                   'mobile_money', 'family_support', 'idem-key-0000000004', 'totp', now())$q$,
        v_alice, v_recipient, v_quote, v_customer_rate),
        'TR002', 'devis déjà consommé refusé');

    -- Devis expiré : refusé à la création du transfert.
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                           payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate,
                           customer_rate, margin_bps, usd_equivalent, created_at, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 299, 10299, 64611, v_mid,
            v_customer_rate, 150, 10800, now() - interval '20 minutes', now() - interval '10 minutes')
    RETURNING id INTO v_quote2;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           VALUES (%L, %L, %L, 'FR', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 64611, %s, 10800, 'wallet_balance',
                   'mobile_money', 'family_support', 'idem-key-0000000005', 'totp', now())$q$,
        v_alice, v_recipient, v_quote2, v_customer_rate),
        'TR002', 'devis expiré refusé');

    -- Machine à états : saut interdit.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'completed' WHERE id = %L$q$, v_transfer),
        'TR001', 'created → completed interdit');

    -- Parcours nominal, chaque étape adossée à son écriture ou à sa tentative.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'funded' WHERE id = %L$q$, v_transfer),
        'TR001', 'financement sans écriture de réservation refusé');
    PERFORM ledger.post_journal(
        'transfer:' || v_transfer || ':funding', 'transfer_hold',
        jsonb_build_array(pg_temp.line(pg_temp.id('alice_wallet_eur'), 'debit', 10299, 'EUR'),
                          pg_temp.line(pg_temp.id('alice_hold_eur'), 'credit', 10299, 'EUR')),
        'Réservation du transfert', 'customer:alice');
    UPDATE transfers.transfers SET status = 'funded' WHERE id = v_transfer;
    UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = v_transfer;

    INSERT INTO payments.payout_corridors (source_country, destination_country, destination_currency, payout_method,
                                           provider, min_amount, max_amount, estimated_delivery_minutes, provider_route_code)
    VALUES (NULL, 'SN', 'XOF', 'mobile_money', 'flutterwave', 500, 2000000, 5, 'FMM')
    RETURNING id INTO v_corridor;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO payments.attempts (transfer_id, direction, provider, corridor_id, idempotency_key, amount, currency)
           VALUES (%L, 'payout', 'flutterwave', %L, 'payout-wrong-amount', 64612, 'XOF')$q$, v_transfer, v_corridor),
        'LG007', 'paiement sortant d''un autre montant refusé');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO payments.attempts (transfer_id, direction, provider, payin_method_id, idempotency_key, amount, currency)
           SELECT %L, 'refund', 'stripe', NULL, 'refund-too-early', 10299, 'EUR'$q$, v_transfer),
        'PY001', 'remboursement hors statut refund_pending refusé');
    INSERT INTO payments.attempts (transfer_id, direction, provider, corridor_id, idempotency_key, amount, currency)
    VALUES (v_transfer, 'payout', 'flutterwave', v_corridor, 'payout-attempt-0001', 64611, 'XOF')
    RETURNING id INTO v_attempt;

    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'payout_processing' WHERE id = %L$q$, v_transfer),
        'TR001', 'paiement sortant non comptabilisé refusé');
    SELECT ledger.post_journal(
        'transfer:' || v_transfer || ':payout:' || v_attempt, 'transfer_payout',
        jsonb_build_array(pg_temp.line(pg_temp.id('alice_hold_eur'), 'debit', 10299, 'EUR'),
                          pg_temp.line(pg_temp.id('fee_eur'), 'credit', 299, 'EUR'),
                          pg_temp.line(pg_temp.id('fxpos_eur'), 'credit', 10000, 'EUR'),
                          pg_temp.line(pg_temp.id('fxpos_xof'), 'debit', 64611, 'XOF'),
                          pg_temp.line(pg_temp.id('payout_xof'), 'credit', 64611, 'XOF')),
        'Paiement sortant', 'system:payout')
      INTO v_journal;
    UPDATE payments.attempts SET ledger_journal_id = v_journal, status = 'processing' WHERE id = v_attempt;
    UPDATE transfers.transfers SET status = 'payout_processing' WHERE id = v_transfer;

    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'completed' WHERE id = %L$q$, v_transfer),
        'TR001', 'terminé sans paiement sortant réussi refusé');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'payout_failed' WHERE id = %L$q$, v_transfer),
        'TR001', 'échec déclaré avec un paiement sortant en cours refusé');
    UPDATE payments.attempts SET status = 'succeeded' WHERE id = v_attempt;
    UPDATE transfers.transfers SET status = 'completed' WHERE id = v_transfer;

    PERFORM pg_temp.assert_true(
        (SELECT completed_at IS NOT NULL AND funded_at IS NOT NULL AND row_version = 5
           FROM transfers.transfers WHERE id = v_transfer),
        'horodatages et version renseignés automatiquement');

    SELECT array_agg(to_status::text ORDER BY id) INTO v_history
      FROM transfers.status_history WHERE transfer_id = v_transfer;
    PERFORM pg_temp.assert_true(
        v_history = ARRAY['created', 'funded', 'payout_pending', 'payout_processing', 'completed'],
        'historique complet des statuts');
    PERFORM pg_temp.assert_true(
        (SELECT bool_and(actor_type = 'customer') FROM transfers.status_history WHERE transfer_id = v_transfer),
        'acteur historisé');

    -- État terminal.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET status = 'refund_pending' WHERE id = %L$q$, v_transfer),
        'TR001', 'aucune transition depuis completed');

    -- Montant figé après création.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE transfers.transfers SET destination_amount = 1 WHERE id = %L$q$, v_transfer),
        'LG006', 'montant du transfert figé');

    -- Plafond KYC : Bob (niveau 1, 500 USD par opération) ne peut envoyer 600 USD.
    INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc,
                                      account_details_enc, account_details_bidx, display_hint,
                                      mobile_operator, pii_key_id)
    VALUES (v_bob, 'SN', 'XOF', 'mobile_money', '\x01', '\x02', sha256('221770000001'), '•••• 0001',
            'orange_money', 'kms-key-v1')
    RETURNING id INTO v_bob_recipient;
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                           payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate,
                           customer_rate, margin_bps, usd_equivalent, expires_at)
    VALUES (v_bob, 'GB', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 55000, 299, 55299,
            fx.convert_minor(55000, v_customer_rate, 'EUR', 'XOF'), v_mid, v_customer_rate, 150, 60000,
            now() + interval '10 minutes')
    RETURNING id INTO v_big_quote;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           SELECT q.user_id, %L, q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency,
                  q.source_amount, q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate, q.usd_equivalent,
                  q.funding_method, q.payout_method, 'family_support', 'idem-key-kyc-limit01', 'totp', now()
             FROM fx.quotes q WHERE q.id = %L$q$, v_bob_recipient, v_big_quote),
        'KY001', 'plafond KYC par opération appliqué');
END;
$$;
