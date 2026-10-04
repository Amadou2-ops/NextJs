-- =============================================================================
-- Balance générale : une ligne par devise tenue au registre, mouvementée ou non.
--
-- La vue de 0010 partait des écritures : une devise dont les comptes sont
-- ouverts mais sans aucun mouvement en était absente. Conséquences : le
-- back-office ne proposait pas cette devise pour un ajustement (le tout
-- premier crédit d'un registre neuf, ou d'une devise nouvellement ouverte,
-- était impossible), et la balance ne montrait pas ces comptes.
--
-- La vue part désormais des soldes (une ligne par compte ouvert) ; les
-- totaux d'une devise sans mouvement valent 0. Colonnes, types et ordre
-- inchangés (CREATE OR REPLACE), privilèges conservés.
-- =============================================================================

CREATE OR REPLACE VIEW ledger.trial_balance
    WITH (security_invoker = true)
AS
WITH movements AS (
    SELECT e.currency,
           COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)  AS total_debits,
           COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS total_credits
      FROM ledger.entries e
     GROUP BY e.currency
),
balances AS (
    SELECT b.currency,
           COALESCE(sum(b.balance) FILTER (WHERE a.normal_side = 'debit'), 0)  AS debit_normal_balances,
           COALESCE(sum(b.balance) FILTER (WHERE a.normal_side = 'credit'), 0) AS credit_normal_balances
      FROM ledger.account_balances b
      JOIN ledger.accounts a ON a.id = b.account_id
     GROUP BY b.currency
)
SELECT b.currency,
       COALESCE(m.total_debits, 0)  AS total_debits,
       COALESCE(m.total_credits, 0) AS total_credits,
       b.debit_normal_balances,
       b.credit_normal_balances,
       (COALESCE(m.total_debits, 0) = COALESCE(m.total_credits, 0)
        AND b.debit_normal_balances = b.credit_normal_balances) AS is_balanced
  FROM balances b
  LEFT JOIN movements m ON m.currency = b.currency;
