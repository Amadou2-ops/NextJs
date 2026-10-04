-- =============================================================================
-- Clôture du compte par le client (0029) : soldes nuls exigés, comptes du
-- registre clôturés, accès révoqués, clôture définitive.
-- =============================================================================

DO $$
DECLARE
    v_carla uuid;
BEGIN
    INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                pii_key_id, status, phone_verified_at, suspended_at)
    VALUES (sha256('fixture-carla'), '\x03', 'FR', '$argon2id$v=19$m=65536,t=3,p=4$fixture', 'FR', 'kms-key-v1', 'suspended', now(), now())
    RETURNING id INTO v_carla;
    INSERT INTO identity.sessions (user_id, audience, assurance_level, mfa_verified_at, idle_expires_at, absolute_expires_at)
    VALUES (pg_temp.id('bob'), 'web', 2, now(), now() + interval '30 minutes', now() + interval '12 hours');
    -- Transfert en cours pour Bob (créé, non financé).
    DECLARE
        v_recipient uuid;
        v_quote     uuid;
        v_rate      numeric := round(655.957 * (10000 - 150)::numeric / 10000, 15);
    BEGIN
        INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc, account_details_enc,
                                          account_details_bidx, display_hint, mobile_operator, pii_key_id)
        VALUES (pg_temp.id('bob'), 'SN', 'XOF', 'mobile_money', '\x01', '\x02', sha256('221779999999'), '•••• 9999', 'orange_money', 'kms-key-v1')
        RETURNING id INTO v_recipient;
        INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                               funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                               margin_bps, usd_equivalent, expires_at)
        VALUES (pg_temp.id('bob'), 'GB', 'SN', 'EUR', 'XOF', 'mobile_money', 'card', 10000, 299, 10299, 64611, 655.957, v_rate, 150, 10800,
                now() + interval '10 minutes')
        RETURNING id INTO v_quote;
        PERFORM set_config('app.actor_type', 'customer', true);
        PERFORM set_config('app.actor_id', pg_temp.id('bob')::text, true);
        INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency,
                                         destination_currency, source_amount, fee_amount, total_debit, destination_amount, customer_rate,
                                         usd_equivalent, funding_method, payout_method, purpose_code, idempotency_key,
                                         authorization_method, authorized_at)
        VALUES (pg_temp.id('bob'), v_recipient, v_quote, 'GB', 'SN', 'EUR', 'XOF', 10000, 299, 10299, 64611, v_rate, 10800, 'card',
                'mobile_money', 'family_support', 'idem-closure-0000001', 'totp', now());
        PERFORM set_config('test.bob_transfer', (SELECT id::text FROM transfers.transfers WHERE idempotency_key = 'idem-closure-0000001'), true);
    END;
    PERFORM set_config('test.alice', pg_temp.id('alice')::text, true);
    PERFORM set_config('test.bob', pg_temp.id('bob')::text, true);
    PERFORM set_config('test.carla', v_carla::text, true);
END;
$$;

SET LOCAL ROLE app_api;

DO $$
DECLARE
    v_alice   uuid := current_setting('test.alice')::uuid;
    v_bob     uuid := current_setting('test.bob')::uuid;
    v_carla   uuid := current_setting('test.carla')::uuid;
    v_revoked integer;
BEGIN
    PERFORM pg_temp.assert_error(format('SELECT identity.close_customer_account(%L)', v_alice), 'ID001', 'solde non nul : clôture refusée');
    PERFORM pg_temp.assert_error(format('SELECT identity.close_customer_account(%L)', v_carla), 'LG006', 'compte suspendu : décision du service client');
    PERFORM pg_temp.assert_error(format('SELECT identity.close_customer_account(%L)', gen_random_uuid()), 'LG007', 'client inconnu');

    PERFORM pg_temp.assert_error(format('SELECT identity.close_customer_account(%L)', v_bob), 'ID002', 'transfert en cours : clôture refusée');
    UPDATE transfers.transfers SET status = 'cancelled', status_reason = 'cancelled_by_customer' WHERE id = current_setting('test.bob_transfer')::uuid;

    v_revoked := identity.close_customer_account(v_bob);
    PERFORM pg_temp.assert_true(v_revoked = 1, 'session révoquée');
    PERFORM pg_temp.assert_true((SELECT status = 'closed' AND closed_at IS NOT NULL FROM identity.users WHERE id = v_bob), 'compte clôturé');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM identity.sessions WHERE user_id = v_bob AND revoked_at IS NULL), 'aucune session active');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM ledger.accounts WHERE owner_user_id = v_bob AND status <> 'closed'), 'comptes du registre clôturés');
    PERFORM pg_temp.assert_error(format('SELECT identity.close_customer_account(%L)', v_bob), 'LG006', 'clôture déjà faite');
    PERFORM pg_temp.assert_error(format($q$UPDATE identity.users SET status = 'active', closed_at = NULL WHERE id = %L$q$, v_bob), 'LG006', 'aucune réouverture');
    -- Plus aucun mouvement possible sur un compte clôturé.
    PERFORM pg_temp.assert_error(format($q$SELECT ledger.open_customer_account(%L, 'customer_wallet', 'USD')$q$, v_bob), 'LG007', 'aucun nouveau compte pour un client clôturé');
END;
$$;

RESET ROLE;
