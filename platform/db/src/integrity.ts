import type { Client } from "pg";

/**
 * Contrôle d'intégrité complet du registre et du journal d'audit. Destiné au
 * job de rapprochement quotidien, aux auditeurs et à la CI. Toute anomalie
 * est une alerte de sévérité maximale.
 */
export interface IntegrityReport {
  readonly journalCount: number;
  readonly auditEventCount: number;
  readonly chainProblems: readonly string[];
  readonly balanceProblems: readonly string[];
  readonly trialBalanceProblems: readonly string[];
  readonly auditChainProblems: readonly string[];
}

export function isHealthy(report: IntegrityReport): boolean {
  return (
    report.chainProblems.length === 0 &&
    report.balanceProblems.length === 0 &&
    report.trialBalanceProblems.length === 0 &&
    report.auditChainProblems.length === 0
  );
}

interface ChainProblemRow {
  seq: string | null;
  journal_id: string | null;
  problem: string;
}

interface BalanceProblemRow {
  account_code: string;
  cached_balance: string | null;
  recomputed_balance: string;
  problem: string;
}

interface TrialBalanceRow {
  currency: string;
  total_debits: string;
  total_credits: string;
  debit_normal_balances: string;
  credit_normal_balances: string;
  is_balanced: boolean;
}

interface AuditProblemRow {
  event_id: string;
  problem: string;
}

interface CountRow {
  count: string;
}

export async function checkIntegrity(client: Client): Promise<IntegrityReport> {
  // Instantané cohérent : toutes les vérifications voient le même état.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const journals = await client.query<CountRow>("SELECT count(*)::text AS count FROM ledger.journals");
    const auditEvents = await client.query<CountRow>("SELECT count(*)::text AS count FROM audit.events");

    const chain = await client.query<ChainProblemRow>(
      "SELECT seq::text, journal_id::text, problem FROM ledger.verify_chain()",
    );
    const balances = await client.query<BalanceProblemRow>(
      `SELECT account_code, cached_balance::text, recomputed_balance::text, problem
         FROM ledger.verify_balances()`,
    );
    const trial = await client.query<TrialBalanceRow>(
      `SELECT currency, total_debits::text, total_credits::text,
              debit_normal_balances::text, credit_normal_balances::text, is_balanced
         FROM ledger.trial_balance`,
    );
    const audit = await client.query<AuditProblemRow>("SELECT event_id::text, problem FROM audit.verify_chain()");
    await client.query("COMMIT");

    return {
      journalCount: Number(journals.rows[0]?.count ?? "0"),
      auditEventCount: Number(auditEvents.rows[0]?.count ?? "0"),
      chainProblems: chain.rows.map(
        (row) => `journal seq=${row.seq ?? "?"} id=${row.journal_id ?? "?"} : ${row.problem}`,
      ),
      balanceProblems: balances.rows.map(
        (row) =>
          `compte ${row.account_code} : ${row.problem} (cache ${row.cached_balance ?? "absent"}, recalculé ${row.recomputed_balance})`,
      ),
      trialBalanceProblems: trial.rows
        .filter((row) => !row.is_balanced)
        .map(
          (row) =>
            `${row.currency} : débits ${row.total_debits} / crédits ${row.total_credits}, ` +
            `soldes débiteurs ${row.debit_normal_balances} / créditeurs ${row.credit_normal_balances}`,
        ),
      auditChainProblems: audit.rows.map((row) => `événement ${row.event_id} : ${row.problem}`),
    };
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}
