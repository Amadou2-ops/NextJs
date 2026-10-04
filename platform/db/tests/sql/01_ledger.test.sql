-- =============================================================================
-- Registre : invariants comptables, immuabilité, idempotence, contre-passation,
-- détection d'altération.
-- =============================================================================
DO $$
DECLARE
    v_alice     uuid := pg_temp.id('alice_wallet_eur');
    v_bob       uuid := pg_temp.id('bob_wallet_eur');
    v_stripe    uuid := pg_temp.id('stripe_eur');
    v_fee       uuid := pg_temp.id('fee_eur');
    v_fxpos_xof uuid := pg_temp.id('fxpos_xof');
    v_j1        uuid;
    v_j1_again  uuid;
    v_rev       uuid;
    v_balance   bigint;
BEGIN
    -- Solde initial issu des fixtures.
    SELECT balance INTO v_balance FROM ledger.account_balances WHERE account_id = v_alice;
    PERFORM pg_temp.assert_true(v_balance = 50000, 'solde initial d''Alice = 500,00 EUR');

    -- Écriture équilibrée : frais de 2,99 EUR.
    v_j1 := ledger.post_journal('test:fee:0001', 'transfer_fee',
        jsonb_build_array(pg_temp.line(v_alice, 'debit', 299, 'EUR'),
                          pg_temp.line(v_fee, 'credit', 299, 'EUR')),
        'Frais de transfert', 'test');
    SELECT balance INTO v_balance FROM ledger.account_balances WHERE account_id = v_alice;
    PERFORM pg_temp.assert_true(v_balance = 49701, 'débit appliqué au portefeuille');

    -- Idempotence : même clé + même contenu → même journal, aucun double débit.
    v_j1_again := ledger.post_journal('test:fee:0001', 'transfer_fee',
        jsonb_build_array(pg_temp.line(v_alice, 'debit', 299, 'EUR'),
                          pg_temp.line(v_fee, 'credit', 299, 'EUR')),
        'Frais de transfert', 'test');
    PERFORM pg_temp.assert_true(v_j1 = v_j1_again, 'rejeu idempotent renvoie le même journal');
    SELECT balance INTO v_balance FROM ledger.account_balances WHERE account_id = v_alice;
    PERFORM pg_temp.assert_true(v_balance = 49701, 'aucun double débit au rejeu');

    -- Même clé, contenu différent → LG005.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:fee:0001', 'transfer_fee',
            jsonb_build_array(pg_temp.line(%L, 'debit', 300, 'EUR'), pg_temp.line(%L, 'credit', 300, 'EUR')),
            'Frais', 'test')$q$, v_alice, v_fee), 'LG005', 'clé d''idempotence réutilisée avec un autre montant');

    -- Déséquilibre → LG002.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:unbalanced:1', 'adjustment',
            jsonb_build_array(pg_temp.line(%L, 'debit', 100, 'EUR'), pg_temp.line(%L, 'credit', 99, 'EUR')),
            'Déséquilibre', 'test')$q$, v_stripe, v_alice), 'LG002', 'journal déséquilibré refusé');

    -- Provision insuffisante → LG001 (Bob n'a rien).
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:overdraft:1', 'transfer_fee',
            jsonb_build_array(pg_temp.line(%L, 'debit', 1, 'EUR'), pg_temp.line(%L, 'credit', 1, 'EUR')),
            'Découvert', 'test')$q$, v_bob, v_fee), 'LG001', 'découvert d''un portefeuille client refusé');

    -- Devise de l'écriture ≠ devise du compte → LG004.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:currency:1', 'adjustment',
            jsonb_build_array(pg_temp.line(%L, 'debit', 100, 'XOF'), pg_temp.line(%L, 'credit', 100, 'XOF')),
            'Mauvaise devise', 'test')$q$, v_fxpos_xof, v_alice), 'LG004', 'devise incohérente refusée');

    -- Montants non entiers, négatifs, nuls, sous forme de texte → LG007.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:decimal:1', 'adjustment',
            '[{"account_id":"%s","direction":"debit","amount":10.5,"currency":"EUR"},
              {"account_id":"%s","direction":"credit","amount":10.5,"currency":"EUR"}]'::jsonb,
            'Décimal', 'test')$q$, v_stripe, v_alice), 'LG007', 'montant décimal refusé');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:negative:1', 'adjustment',
            '[{"account_id":"%s","direction":"debit","amount":-100,"currency":"EUR"},
              {"account_id":"%s","direction":"credit","amount":-100,"currency":"EUR"}]'::jsonb,
            'Négatif', 'test')$q$, v_stripe, v_alice), 'LG007', 'montant négatif refusé');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:string:1', 'adjustment',
            '[{"account_id":"%s","direction":"debit","amount":"100","currency":"EUR"},
              {"account_id":"%s","direction":"credit","amount":"100","currency":"EUR"}]'::jsonb,
            'Texte', 'test')$q$, v_stripe, v_alice), 'LG007', 'montant transmis en texte refusé');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:extra:1', 'adjustment',
            '[{"account_id":"%s","direction":"debit","amount":100,"currency":"EUR","x":1},
              {"account_id":"%s","direction":"credit","amount":100,"currency":"EUR"}]'::jsonb,
            'Champ en trop', 'test')$q$, v_stripe, v_alice), 'LG007', 'champ inattendu refusé');

    -- Un compte à la fois débité et crédité → LG007.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:bothsides:1', 'adjustment',
            jsonb_build_array(pg_temp.line(%1$L, 'debit', 100, 'EUR'), pg_temp.line(%1$L, 'credit', 100, 'EUR')),
            'Aller-retour', 'test')$q$, v_alice), 'LG007', 'débit et crédit du même compte refusés');

    -- Une contre-passation ne passe pas par post_journal → LG008.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:fake-reversal:1', 'reversal',
            jsonb_build_array(pg_temp.line(%L, 'debit', 1, 'EUR'), pg_temp.line(%L, 'credit', 1, 'EUR')),
            'Fausse contre-passation', 'test')$q$, v_fee, v_alice), 'LG008', 'type reversal interdit hors reverse_journal');

    -- Contre-passation : rétablit le solde, une seule fois.
    v_rev := ledger.reverse_journal(v_j1, 'test:rev:0001', 'Frais appliqués par erreur', 'admin:test');
    SELECT balance INTO v_balance FROM ledger.account_balances WHERE account_id = v_alice;
    PERFORM pg_temp.assert_true(v_balance = 50000, 'contre-passation rétablit le solde');
    PERFORM pg_temp.assert_true(
        ledger.reverse_journal(v_j1, 'test:rev:0001', 'Frais appliqués par erreur', 'admin:test') = v_rev,
        'contre-passation idempotente');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.reverse_journal(%L, 'test:rev:0002', 'Seconde tentative', 'admin:test')$q$, v_j1),
        'LG008', 'double contre-passation refusée');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.reverse_journal(%L, 'test:rev:0003', 'Contre-passer la contre-passation', 'admin:test')$q$, v_rev),
        'LG008', 'contre-passation d''une contre-passation refusée');

    -- Compte gelé : aucun mouvement ordinaire → LG003.
    PERFORM ledger.set_account_status(v_alice, 'frozen', 'Réquisition judiciaire n°42');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('test:frozen:1', 'transfer_fee',
            jsonb_build_array(pg_temp.line(%L, 'debit', 100, 'EUR'), pg_temp.line(%L, 'credit', 100, 'EUR')),
            'Sur compte gelé', 'test')$q$, v_alice, v_fee), 'LG003', 'mouvement sur compte gelé refusé');
    PERFORM ledger.set_account_status(v_alice, 'active', NULL);

    -- Clôture impossible avec un solde non nul.
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.set_account_status(%L, 'closed', 'Demande du client')$q$, v_alice),
        'LG003', 'clôture d''un compte non soldé refusée');

    -- Immuabilité, y compris pour le propriétaire des tables.
    PERFORM pg_temp.assert_error(
        'UPDATE ledger.entries SET amount = amount + 1', 'LG006', 'modification d''écriture refusée');
    PERFORM pg_temp.assert_error(
        'DELETE FROM ledger.entries', 'LG006', 'suppression d''écriture refusée');
    PERFORM pg_temp.assert_error(
        'UPDATE ledger.journals SET description = ''altéré''', 'LG006', 'modification de journal refusée');
    -- PostgreSQL refuse TRUNCATE tant que des triggers différés sont en
    -- attente dans la transaction : on les exécute d'abord.
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM pg_temp.assert_error(
        'TRUNCATE ledger.entries CASCADE', 'LG006', 'TRUNCATE refusé');
    PERFORM pg_temp.assert_error(
        format('UPDATE ledger.account_balances SET balance = 999999999 WHERE account_id = %L', v_alice),
        'LG006', 'modification directe d''un solde refusée');
    PERFORM pg_temp.assert_error(
        format('INSERT INTO ledger.entries (journal_id, line_no, account_id, direction, amount, currency, balance_after, account_entry_seq)
                VALUES (%L, 9, %L, ''credit'', 100, ''EUR'', 0, 999)', v_j1, v_alice),
        'LG006', 'insertion directe d''écriture refusée');
    PERFORM pg_temp.assert_error(
        format('UPDATE ledger.accounts SET currency = ''USD'' WHERE id = %L', v_alice),
        'LG006', 'changement de devise d''un compte refusé');
    PERFORM pg_temp.assert_error(
        format('UPDATE ledger.accounts SET allow_negative = true WHERE id = %L', v_alice),
        'LG006', 'autorisation de découvert d''un compte client refusée');

    -- Même avec le drapeau interne levé, l'invariant d'équilibre tient au COMMIT.
    PERFORM pg_temp.assert_error(
        format($q$DO $i$ BEGIN
            PERFORM set_config('ledger.internal_write', 'on', true);
            INSERT INTO ledger.entries (journal_id, line_no, account_id, direction, amount, currency, balance_after, account_entry_seq)
            VALUES (%L, 9, %L, 'credit', 100, 'EUR', 0, 999);
            PERFORM set_config('ledger.internal_write', '', true);
        END $i$ $q$, v_j1, v_alice),
        'LG002', 'écriture orpheline déséquilibrant un journal détectée au COMMIT');

    -- Intégrité : chaîne et soldes cohérents.
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM ledger.verify_chain()), 'chaîne d''empreintes intacte');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM ledger.verify_balances()), 'soldes recalculés identiques');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM ledger.trial_balance WHERE NOT is_balanced), 'balance générale équilibrée');
END;
$$;

-- Simulation d'un administrateur de base malveillant (superutilisateur) qui
-- désactive tous les triggers de la session et modifie un montant : la
-- falsification n'est pas empêchée à ce niveau de privilège, mais elle est
-- DÉTECTÉE par la chaîne d'empreintes et la balance générale.
SET LOCAL session_replication_role = replica;
UPDATE ledger.entries SET amount = amount + 1000 WHERE line_no = 2 AND journal_id =
    (SELECT id FROM ledger.journals WHERE idempotency_key = 'fixture:alice:funding:1');
SET LOCAL session_replication_role = origin;

DO $$
BEGIN
    PERFORM pg_temp.assert_true(
        EXISTS (SELECT 1 FROM ledger.verify_chain() WHERE problem LIKE 'empreinte recalculée%'),
        'verify_chain détecte un montant altéré');
    PERFORM pg_temp.assert_true(
        EXISTS (SELECT 1 FROM ledger.trial_balance WHERE NOT is_balanced),
        'la balance générale détecte le déséquilibre');
END;
$$;
