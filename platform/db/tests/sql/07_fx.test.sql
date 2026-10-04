-- =============================================================================
-- Change (0019) : journal des collectes, vue des derniers taux, mode de
-- financement figé dans le devis.
-- =============================================================================
DO $$
DECLARE
    v_alice     uuid := pg_temp.id('alice');
    v_recipient uuid;
    v_quote     uuid;
    v_fetch     bigint;
    v_rate      numeric;
BEGIN
    -- Journal des collectes : immuable, cohérent.
    INSERT INTO fx.rate_fetches (provider, status, rates_received, rates_stored)
    VALUES ('open_exchange_rates', 'succeeded', 170, 168) RETURNING id INTO v_fetch;
    PERFORM pg_temp.assert_error(format('UPDATE fx.rate_fetches SET rates_stored = 0 WHERE id = %s', v_fetch),
        'LG006', 'collecte immuable');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO fx.rate_fetches (provider, status, rates_received, rates_stored) VALUES ('fixer', 'failed', 0, 0)$q$,
        '23514', 'échec sans message refusé');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO fx.rate_fetches (provider, status, rates_received, rates_stored) VALUES ('fixer', 'partially_rejected', 5, 4)$q$,
        '23514', 'rejet partiel sans détail refusé');

    -- Vue des derniers taux contre USD.
    INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
    VALUES ('open_exchange_rates', 'USD', 'XOF', 600.5, now() - interval '2 hours'),
           ('open_exchange_rates', 'USD', 'XOF', 601.25, now() - interval '1 hour'),
           ('fixer', 'USD', 'XOF', 601.3, now() - interval '30 minutes');
    SELECT rate INTO v_rate FROM fx.latest_usd_rates WHERE provider = 'open_exchange_rates' AND currency = 'XOF';
    PERFORM pg_temp.assert_true(v_rate = 601.25, 'dernier taux par fournisseur');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM fx.latest_usd_rates WHERE currency = 'XOF') = 2, 'un taux par fournisseur');

    -- Mode de financement : un transfert doit reprendre celui du devis.
    INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc, account_details_enc,
                                      account_details_bidx, display_hint, mobile_operator, pii_key_id)
    VALUES (v_alice, 'SN', 'XOF', 'mobile_money', '\x01', '\x02', sha256('fx-test'), '•••• 1111', 'wave', 'kms-key-v1')
    RETURNING id INTO v_recipient;
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                           funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                           margin_bps, usd_equivalent, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'card', 10000, 299, 10299,
            fx.convert_minor(10000, round(655.957 * 9850 / 10000.0, 15), 'EUR', 'XOF'), 655.957,
            round(655.957 * 9850 / 10000.0, 15), 150, 10800, now() + interval '10 minutes')
    RETURNING id INTO v_quote;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country,
                source_currency, destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                customer_rate, usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                authorization_method, authorized_at)
           SELECT %L, %L, q.id, 'FR', 'SN', 'EUR', 'XOF', q.source_amount, q.fee_amount, q.total_debit, q.destination_amount,
                  q.customer_rate, q.usd_equivalent, 'wallet_balance', 'mobile_money', 'family_support', 'idem-key-fx-0000001',
                  'totp', now()
             FROM fx.quotes q WHERE q.id = %L$q$, v_alice, v_recipient, v_quote),
        'TR002', 'transfert avec un autre mode de financement que le devis refusé');

    -- Taux client à un seul arrondi (demi vers le haut à 15 décimales) :
    -- 655,956521739130435 × 0,985 = 646,117173913043478475 → …478, jamais …479.
    INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                           funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                           margin_bps, usd_equivalent, expires_at)
    VALUES (v_alice, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'card', 10000, 199, 10199, 64611,
            655.956521739130435, 646.117173913043478, 150, 10869, now() + interval '10 minutes');
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency,
                payout_method, funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate,
                customer_rate, margin_bps, usd_equivalent, expires_at)
           VALUES (%L, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'card', 10000, 199, 10199, 64611, 655.956521739130435,
                   646.117173913043479, 150, 10869, now() + interval '10 minutes')$q$, v_alice),
        'LG007', 'taux client doublement arrondi refusé');
END;
$$;
