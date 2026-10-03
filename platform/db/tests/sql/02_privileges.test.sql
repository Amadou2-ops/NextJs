-- =============================================================================
-- Privilèges : le rôle applicatif ne peut modifier le registre qu'au travers
-- des fonctions publiques, et le rôle lecture seule ne voit aucun secret.
-- =============================================================================
INSERT INTO fx_ids (key, id) VALUES ('j_api', gen_random_uuid());
GRANT SELECT ON fx_ids TO app_api, app_readonly;

SET LOCAL ROLE app_api;

DO $$
DECLARE
    v_alice uuid := pg_temp.id('alice_wallet_eur');
    v_fee   uuid := pg_temp.id('fee_eur');
    v_j     uuid;
BEGIN
    -- Chemin autorisé.
    v_j := ledger.post_journal('test:api:fee:1', 'transfer_fee',
        jsonb_build_array(pg_temp.line(v_alice, 'debit', 150, 'EUR'),
                          pg_temp.line(v_fee, 'credit', 150, 'EUR')),
        'Frais via rôle applicatif', 'api:test');
    PERFORM pg_temp.assert_true(v_j IS NOT NULL, 'app_api peut appeler ledger.post_journal');
    PERFORM pg_temp.assert_true(
        (SELECT available FROM ledger.customer_balances WHERE user_id = pg_temp.id('alice') AND currency = 'EUR') = 49850,
        'app_api lit les soldes clients');

    -- Écritures directes : privilège insuffisant (42501).
    PERFORM pg_temp.assert_error(format(
        'UPDATE ledger.account_balances SET balance = 1 WHERE account_id = %L', v_alice),
        '42501', 'app_api ne peut pas modifier un solde');
    PERFORM pg_temp.assert_error(format(
        'INSERT INTO ledger.accounts (code, account_type, normal_side, currency, name)
         VALUES (''system:suspense:EUR'', ''suspense'', ''debit'', ''EUR'', ''x'')'),
        '42501', 'app_api ne peut pas créer de compte hors fonction');
    PERFORM pg_temp.assert_error(
        'DELETE FROM ledger.journals', '42501', 'app_api ne peut pas supprimer de journal');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger._post_journal('test:internal:1', 'reversal',
            jsonb_build_array(pg_temp.line(%L, 'debit', 1, 'EUR'), pg_temp.line(%L, 'credit', 1, 'EUR')),
            'x', 'x', NULL, NULL, '{}'::jsonb, NULL, %L)$q$, v_fee, v_alice, pg_temp.id('j_api')),
        '42501', 'app_api ne peut pas appeler le cœur interne du registre');
    PERFORM pg_temp.assert_error(
        'UPDATE ledger.chain_head SET last_seq = 0', '42501', 'app_api ne peut pas toucher la tête de chaîne');
    PERFORM pg_temp.assert_error(
        'INSERT INTO transfers.status_history (transfer_id, to_status, actor_type) VALUES (gen_random_uuid(), ''completed'', ''system'')',
        '42501', 'app_api ne peut pas forger l''historique des transferts');
    PERFORM pg_temp.assert_error(
        'UPDATE fx.quotes SET consumed_at = now()', '42501', 'app_api ne peut pas consommer un devis directement');
    PERFORM pg_temp.assert_error(
        'UPDATE transfers.transfers SET source_amount = 1', '42501', 'app_api ne peut pas modifier un montant de transfert');
    PERFORM pg_temp.assert_error(
        'INSERT INTO audit.events (id, actor_type, action, prev_hash, hash) VALUES (1, ''system'', ''a.b'', ''\x00'', ''\x00'')',
        '42501', 'app_api ne peut pas écrire dans l''audit hors audit.record()');
    PERFORM pg_temp.assert_error(
        'INSERT INTO backoffice.role_permissions VALUES (''support'', ''ledger:adjust'')',
        '42501', 'app_api ne peut pas élargir la matrice RBAC');

    -- audit.record est autorisé.
    PERFORM audit.record('system', 'api:test', 'privileges.check', 'user', pg_temp.id('alice')::text);
END;
$$;

RESET ROLE;
SET LOCAL ROLE app_readonly;

DO $$
BEGIN
    PERFORM pg_temp.assert_error('SELECT token_sha256 FROM identity.refresh_tokens', '42501',
        'app_readonly ne lit pas les jetons de renouvellement');
    PERFORM pg_temp.assert_error('SELECT password_hash FROM identity.users', '42501',
        'app_readonly ne lit pas les empreintes de mot de passe');
    PERFORM pg_temp.assert_error('SELECT mfa_totp_secret_enc FROM identity.users', '42501',
        'app_readonly ne lit pas les secrets TOTP');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM identity.users WHERE status = 'active') >= 2,
        'app_readonly lit les colonnes non sensibles des clients');
    PERFORM pg_temp.assert_error('SELECT ledger.post_journal(''x'', ''adjustment'', ''[]''::jsonb, ''x'', ''x'')', '42501',
        'app_readonly ne peut pas passer d''écriture');
END;
$$;

RESET ROLE;
