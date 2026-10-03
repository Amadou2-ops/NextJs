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

    -- Parcours nominal.
    UPDATE transfers.transfers SET status = 'funded' WHERE id = v_transfer;
    UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = v_transfer;
    UPDATE transfers.transfers SET status = 'payout_processing' WHERE id = v_transfer;
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
END;
$$;
