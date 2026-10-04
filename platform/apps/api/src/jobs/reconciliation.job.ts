import type { Logger } from "pino";

import type { DatabasePool } from "../db/pool.js";
import type { Job } from "./scheduler.js";

/**
 * Rapprochement d'intégrité du registre.
 *
 * À chaque exécution :
 *   1. recalcul de la chaîne d'empreintes depuis le dernier seq vérifié sain
 *      (incrémental) jusqu'à la tête, et contrôle de la tête de chaîne ; une
 *      vérification COMPLÈTE depuis le seq 1 est faite si aucune n'a été
 *      saine depuis 24 heures (détecte l'altération d'un journal ancien
 *      sans effet sur les soldes, ex. son libellé) ;
 *   2. recalcul complet des soldes à partir des écritures ;
 *   3. balance générale par devise ;
 *   4. chaîne du journal d'audit.
 * Le résultat est historisé (ledger.reconciliation_runs). Toute anomalie
 * déclenche une alerte de sévérité maximale (journal fatal + événement outbox
 * « ledger.integrity_breach » vers l'astreinte) et suspend l'avancée de la
 * vérification incrémentale jusqu'à résolution.
 */

export interface IntegrityProblem {
  readonly check: "chain" | "chain_head" | "balances" | "trial_balance" | "audit_chain";
  readonly detail: string;
}

export type ReconciliationScope = "incremental" | "full";

/** Intervalle maximal entre deux vérifications complètes saines de la chaîne. */
export const FULL_VERIFICATION_INTERVAL_HOURS = 24;

export interface ReconciliationResult {
  readonly runId: string;
  readonly scope: ReconciliationScope;
  readonly status: "healthy" | "anomalies" | "error";
  readonly verifiedFromSeq: bigint;
  readonly verifiedToSeq: bigint;
  readonly problems: readonly IntegrityProblem[];
}

export class ReconciliationJob implements Job {
  readonly name = "ledger-reconciliation";

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    private readonly workerId: string,
    readonly intervalMs: number,
  ) {}

  async run(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(requestedScope?: ReconciliationScope): Promise<ReconciliationResult> {
    let scope: ReconciliationScope;
    if (requestedScope === undefined) {
      const recentFull = await this.pool.query(
        `SELECT 1 FROM ledger.reconciliation_runs
          WHERE scope = 'full' AND status = 'healthy' AND started_at > now() - make_interval(hours => $1)`,
        [FULL_VERIFICATION_INTERVAL_HOURS],
      );
      scope = recentFull.rowCount === 0 ? "full" : "incremental";
    } else {
      scope = requestedScope;
    }
    const started = await this.pool.query<{ id: bigint }>(
      "INSERT INTO ledger.reconciliation_runs (worker_id, scope) VALUES ($1, $2) RETURNING id",
      [this.workerId, scope],
    );
    const runId = started.rows[0]?.id;
    if (runId === undefined) throw new Error("création du rapprochement impossible");

    const client = await this.pool.connect();
    try {
      // Instantané cohérent pour l'ensemble des contrôles.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const lastHealthy = await client.query<{ verified_to_seq: bigint }>(
        "SELECT verified_to_seq FROM ledger.reconciliation_runs WHERE status = 'healthy' ORDER BY verified_to_seq DESC LIMIT 1",
      );
      const head = await client.query<{ last_seq: bigint; last_hash: Buffer }>("SELECT last_seq, last_hash FROM ledger.chain_head");
      const chainHead = head.rows[0];
      if (chainHead === undefined) throw new Error("tête de chaîne absente");
      const fromSeq = scope === "full" ? 1n : (lastHealthy.rows[0]?.verified_to_seq ?? 0n) + 1n;
      const toSeq = chainHead.last_seq;
      const problems: IntegrityProblem[] = [];

      if (toSeq >= fromSeq) {
        const chain = await client.query<{ seq: bigint | null; problem: string }>("SELECT seq, problem FROM ledger.verify_chain($1, $2)", [
          fromSeq.toString(),
          toSeq.toString(),
        ]);
        for (const row of chain.rows) problems.push({ check: "chain", detail: `seq ${row.seq?.toString() ?? "?"} : ${row.problem}` });
      }
      if (toSeq > 0n) {
        const tip = await client.query<{ hash: Buffer }>("SELECT hash FROM ledger.journals WHERE seq = $1", [toSeq.toString()]);
        if (tip.rows[0]?.hash.equals(chainHead.last_hash) !== true) {
          problems.push({ check: "chain_head", detail: `la tête de chaîne (seq ${toSeq.toString()}) ne correspond pas au dernier journal` });
        }
      }
      const balances = await client.query<{ account_code: string; problem: string }>("SELECT account_code, problem FROM ledger.verify_balances()");
      for (const row of balances.rows) problems.push({ check: "balances", detail: `${row.account_code} : ${row.problem}` });
      const accounts = await client.query<{ count: bigint }>("SELECT count(*) AS count FROM ledger.accounts");
      const trial = await client.query<{ currency: string }>("SELECT currency FROM ledger.trial_balance WHERE NOT is_balanced");
      for (const row of trial.rows) problems.push({ check: "trial_balance", detail: `balance générale déséquilibrée en ${row.currency}` });
      const audit = await client.query<{ event_id: bigint; problem: string }>("SELECT event_id, problem FROM audit.verify_chain()");
      for (const row of audit.rows) problems.push({ check: "audit_chain", detail: `événement ${row.event_id.toString()} : ${row.problem}` });
      await client.query("COMMIT");

      const status = problems.length === 0 ? "healthy" : "anomalies";
      await this.pool.query(
        `UPDATE ledger.reconciliation_runs
            SET status = $2, finished_at = clock_timestamp(), verified_from_seq = $3, verified_to_seq = $4,
                chain_head_seq = $4, chain_head_hash = $5, balances_checked = $6, problems = $7::jsonb
          WHERE id = $1`,
        [runId.toString(), status, fromSeq.toString(), toSeq.toString(), chainHead.last_hash, Number(accounts.rows[0]?.count ?? 0n), JSON.stringify(problems)],
      );

      if (status === "anomalies") {
        this.logger.fatal({ runId: runId.toString(), problems }, "ALERTE : anomalie d'intégrité du registre");
        await this.pool.query(
          `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
           VALUES ('ledger', gen_random_uuid(), 'ledger.integrity_breach', $1::jsonb, $2)`,
          [JSON.stringify({ runId: runId.toString(), problems: problems.slice(0, 50) }), `ledger.integrity_breach:${runId.toString()}`],
        );
      }
      return { runId: runId.toString(), scope, status, verifiedFromSeq: fromSeq, verifiedToSeq: toSeq, problems };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await this.pool.query(
        "UPDATE ledger.reconciliation_runs SET status = 'error', finished_at = clock_timestamp(), error_message = $2 WHERE id = $1",
        [runId.toString(), message.slice(0, 2000)],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}
