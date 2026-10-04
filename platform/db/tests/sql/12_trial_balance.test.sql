-- =============================================================================
-- Balance générale (0025) : une devise dont les comptes sont ouverts sans
-- aucun mouvement y figure, équilibrée à zéro.
-- =============================================================================
DO $$
DECLARE
    v_row ledger.trial_balance%ROWTYPE;
BEGIN
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM ledger.entries WHERE currency = 'CHF'), 'aucun mouvement en CHF avant le test');
    PERFORM ledger.open_system_account('equity', 'CHF');

    SELECT * INTO v_row FROM ledger.trial_balance WHERE currency = 'CHF';
    PERFORM pg_temp.assert_true(FOUND, 'devise ouverte sans mouvement présente dans la balance');
    PERFORM pg_temp.assert_true(v_row.total_debits = 0 AND v_row.total_credits = 0, 'totaux nuls sans mouvement');
    PERFORM pg_temp.assert_true(v_row.debit_normal_balances = 0 AND v_row.credit_normal_balances = 0, 'soldes nuls sans mouvement');
    PERFORM pg_temp.assert_true(v_row.is_balanced, 'devise sans mouvement équilibrée');

    -- Toute devise mouvementée a des comptes : aucune ligne perdue par la jointure.
    PERFORM pg_temp.assert_true(
        NOT EXISTS (SELECT DISTINCT e.currency FROM ledger.entries e EXCEPT SELECT t.currency FROM ledger.trial_balance t),
        'chaque devise mouvementée figure dans la balance');
END;
$$;
