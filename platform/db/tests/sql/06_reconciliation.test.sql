-- =============================================================================
-- Rapprochements (0018) : résultat figé une fois terminé, cohérence des
-- statuts, preuves d'ancrage.
-- =============================================================================
DO $$
DECLARE
    v_run bigint;
BEGIN
    INSERT INTO ledger.reconciliation_runs (worker_id, scope) VALUES ('test', 'full') RETURNING id INTO v_run;

    PERFORM pg_temp.assert_error(format(
        $q$UPDATE ledger.reconciliation_runs SET status = 'healthy', finished_at = now(), problems = '[{"check":"chain"}]' WHERE id = %s$q$, v_run),
        '23514', 'rapprochement sain avec anomalies refusé');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE ledger.reconciliation_runs SET status = 'anomalies', finished_at = now() WHERE id = %s$q$, v_run),
        '23514', 'anomalies sans détail refusées');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE ledger.reconciliation_runs SET status = 'healthy', finished_at = now(), verified_from_seq = 5, verified_to_seq = 10 WHERE id = %s$q$, v_run),
        '23514', 'vérification complète ne commençant pas au seq 1 refusée');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE ledger.reconciliation_runs SET scope = 'incremental' WHERE id = %s$q$, v_run),
        'LG006', 'portée figée');

    UPDATE ledger.reconciliation_runs
       SET status = 'healthy', finished_at = now(), verified_from_seq = 1, verified_to_seq = 1
     WHERE id = v_run;
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE ledger.reconciliation_runs SET status = 'anomalies', problems = '[{"x":1}]' WHERE id = %s$q$, v_run),
        'LG006', 'résultat figé après la fin');
    PERFORM pg_temp.assert_error(format('DELETE FROM ledger.reconciliation_runs WHERE id = %s', v_run),
        'LG006', 'historique non supprimable');

    -- Preuve d'ancrage : type et contenu vont de pair.
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO ledger.chain_anchors (seq, hash, anchor_target, external_reference, evidence)
           SELECT seq, hash, 'test', 'ref', '\x00' FROM ledger.journals ORDER BY seq LIMIT 1$q$,
        '23514', 'preuve sans type refusée');
END;
$$;
