-- =============================================================================
-- Fixtures communes, exécutées dans la transaction de chaque test SQL (puis
-- annulées avec lui). Fournit des assertions et un jeu de données minimal.
-- =============================================================================

-- Échoue si la condition est fausse.
CREATE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
    RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    IF p_condition IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'ASSERTION ÉCHOUÉE : %', p_message;
    END IF;
END;
$$;

-- Exécute p_sql et exige l'erreur p_expected_sqlstate. Les contraintes
-- différées sont forcées immédiatement afin de tester aussi les invariants
-- vérifiés au COMMIT. L'instruction est exécutée dans un sous-bloc : son
-- effet est annulé.
CREATE FUNCTION pg_temp.assert_error(p_sql text, p_expected_sqlstate text, p_message text)
    RETURNS void
    LANGUAGE plpgsql
AS $$
DECLARE
    v_state text;
    v_text  text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        SET CONSTRAINTS ALL IMMEDIATE;
        SET CONSTRAINTS ALL DEFERRED;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_text = MESSAGE_TEXT;
        IF v_state <> p_expected_sqlstate THEN
            RAISE EXCEPTION 'ASSERTION ÉCHOUÉE : % — SQLSTATE % attendu, % obtenu (%)',
                p_message, p_expected_sqlstate, v_state, v_text;
        END IF;
        RETURN;
    END;
    RAISE EXCEPTION 'ASSERTION ÉCHOUÉE : % — l''erreur % était attendue mais l''instruction a réussi',
        p_message, p_expected_sqlstate;
END;
$$;

-- Écriture d'une ligne de journal au format attendu par ledger.post_journal.
CREATE FUNCTION pg_temp.line(p_account_id uuid, p_direction text, p_amount bigint, p_currency text)
    RETURNS jsonb
    LANGUAGE sql
AS $$
    SELECT jsonb_build_object('account_id', p_account_id, 'direction', p_direction,
                              'amount', p_amount, 'currency', p_currency);
$$;

-- Valeurs partagées entre fixtures et tests.
CREATE TEMPORARY TABLE fx_ids (
    key   text PRIMARY KEY,
    id    uuid NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.id(p_key text)
    RETURNS uuid
    LANGUAGE sql
AS $$
    SELECT id FROM fx_ids WHERE key = p_key;
$$;

-- Ouverture commerciale minimale.
UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF', 'GBP');
UPDATE ref.countries SET can_send = true WHERE alpha2 IN ('FR', 'GB', 'US');
UPDATE ref.countries SET can_receive = true WHERE alpha2 IN ('SN', 'CI');

-- Deux clients.
WITH inserted AS (
    INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                pii_key_id, status, phone_verified_at, kyc_tier)
    VALUES (sha256('fixture-alice'), '\x01', 'FR', '$argon2id$v=19$m=65536,t=3,p=4$fixture', 'FR',
            'kms-key-v1', 'active', now(), 'tier_2'),
           (sha256('fixture-bob'), '\x02', 'GB', '$argon2id$v=19$m=65536,t=3,p=4$fixture', 'GB',
            'kms-key-v1', 'active', now(), 'tier_1')
    RETURNING id, phone_country
)
INSERT INTO fx_ids (key, id)
SELECT CASE phone_country WHEN 'FR' THEN 'alice' ELSE 'bob' END, id FROM inserted;

-- Comptes du registre.
INSERT INTO fx_ids (key, id) VALUES
    ('alice_wallet_eur',  ledger.open_customer_account(pg_temp.id('alice'), 'customer_wallet', 'EUR')),
    ('alice_hold_eur',    ledger.open_customer_account(pg_temp.id('alice'), 'customer_hold', 'EUR')),
    ('bob_wallet_eur',    ledger.open_customer_account(pg_temp.id('bob'), 'customer_wallet', 'EUR')),
    ('stripe_eur',        ledger.open_system_account('provider_settlement', 'EUR', 'stripe')),
    ('flutterwave_xof',   ledger.open_system_account('provider_settlement', 'XOF', 'flutterwave')),
    ('payout_xof',        ledger.open_system_account('payout_clearing', 'XOF', 'flutterwave')),
    ('fee_eur',           ledger.open_system_account('fee_revenue', 'EUR')),
    ('fxpos_eur',         ledger.open_system_account('fx_position', 'EUR')),
    ('fxpos_xof',         ledger.open_system_account('fx_position', 'XOF'));

-- Alice dispose de 500,00 EUR (encaissement carte via Stripe).
SELECT ledger.post_journal(
    'fixture:alice:funding:1',
    'wallet_funding',
    jsonb_build_array(
        pg_temp.line(pg_temp.id('stripe_eur'), 'debit', 50000, 'EUR'),
        pg_temp.line(pg_temp.id('alice_wallet_eur'), 'credit', 50000, 'EUR')
    ),
    'Rechargement carte (fixture)',
    'system:fixtures'
);
