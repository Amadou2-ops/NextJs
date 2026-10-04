import type { DatabasePool } from "../../db/pool.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import type { PaymentOrchestrator } from "../transfers/payment.orchestrator.js";
import { adminActor, recordAdminAudit } from "./access.js";
import type { AdminRequestContext } from "./access.js";

/**
 * Transferts vus du back-office : file, détail complet (historique,
 * tentatives de paiement, écritures, alertes, évaluation AML) et décisions de
 * conformité. Le remboursement ordonné passe par la double validation
 * (approvals : refund_transfer).
 */

interface TransferListRow {
  id: string;
  reference: string;
  user_id: string;
  status: string;
  status_reason: string | null;
  source_country: string;
  destination_country: string;
  source_currency: string;
  destination_currency: string;
  source_amount: string;
  fee_amount: string;
  total_debit: string;
  destination_amount: string;
  usd_equivalent: string;
  funding_method: string;
  payout_method: string;
  created_at: Date;
  updated_at: Date;
}

const LIST_SELECT = `
  SELECT t.id, t.reference, t.user_id, t.status::text, t.status_reason, t.source_country, t.destination_country,
         t.source_currency, t.destination_currency, t.source_amount::text, t.fee_amount::text, t.total_debit::text,
         t.destination_amount::text, t.usd_equivalent::text, t.funding_method::text, t.payout_method::text, t.created_at, t.updated_at
    FROM transfers.transfers t`;

function presentTransfer(row: TransferListRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id,
    status: row.status,
    statusReason: row.status_reason,
    corridor: { from: row.source_country, to: row.destination_country },
    send: { amountMinor: row.source_amount, currency: row.source_currency },
    fee: { amountMinor: row.fee_amount, currency: row.source_currency },
    totalDebit: { amountMinor: row.total_debit, currency: row.source_currency },
    receive: { amountMinor: row.destination_amount, currency: row.destination_currency },
    usdEquivalentMinor: row.usd_equivalent,
    fundingMethod: row.funding_method,
    payoutMethod: row.payout_method,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class TransfersAdminService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly orchestrator: PaymentOrchestrator;
    },
  ) {}

  async list(filter: {
    readonly status?: string | undefined;
    readonly userId?: string | undefined;
    readonly reference?: string | undefined;
    readonly before?: string | undefined;
    readonly limit: number;
  }): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[]; readonly nextCursor: string | null }> {
    const result = await this.deps.pool.query<TransferListRow>(
      `${LIST_SELECT}
        WHERE ($1::text IS NULL OR t.status::text = $1)
          AND ($2::uuid IS NULL OR t.user_id = $2)
          AND ($3::text IS NULL OR t.reference = $3)
          AND ($4::timestamptz IS NULL OR t.created_at < $4)
        ORDER BY t.created_at DESC
        LIMIT $5`,
      [filter.status ?? null, filter.userId ?? null, filter.reference ?? null, filter.before ?? null, filter.limit + 1],
    );
    const rows = result.rows.slice(0, filter.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(presentTransfer),
      nextCursor: result.rows.length > filter.limit && last !== undefined ? last.created_at.toISOString() : null,
    };
  }

  async detail(transferId: string): Promise<Readonly<Record<string, unknown>>> {
    const found = await this.deps.pool.query<TransferListRow>(`${LIST_SELECT} WHERE t.id = $1`, [transferId]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError("Transfert introuvable.");
    const [history, attempts, journals, alerts, evaluation] = await Promise.all([
      this.deps.pool.query<{ from_status: string | null; to_status: string; reason: string | null; actor_type: string; actor_id: string | null; created_at: Date }>(
        "SELECT from_status::text, to_status::text, reason, actor_type::text, actor_id, created_at FROM transfers.status_history WHERE transfer_id = $1 ORDER BY id",
        [transferId],
      ),
      this.deps.pool.query<{ id: string; direction: string; provider: string; status: string; amount: string; currency: string; provider_reference: string | null; failure_code: string | null; created_at: Date; updated_at: Date }>(
        `SELECT id, direction::text, provider::text, status::text, amount::text, currency, provider_reference, failure_code, created_at, updated_at
           FROM payments.attempts WHERE transfer_id = $1 ORDER BY created_at`,
        [transferId],
      ),
      this.deps.pool.query<{ id: string; seq: string; journal_type: string; idempotency_key: string; created_at: Date; reverses_journal_id: string | null }>(
        `SELECT id, seq::text, journal_type::text, idempotency_key, created_at, reverses_journal_id
           FROM ledger.journals WHERE (reference_type = 'transfer' AND reference_id = $1::uuid)
              OR idempotency_key LIKE 'transfer:' || $1::text || ':%'
          ORDER BY seq`,
        [transferId],
      ),
      this.deps.pool.query<{ id: string; rule_code: string; severity: string; status: string; created_at: Date; resolved_at: Date | null }>(
        "SELECT id, rule_code, severity::text, status::text, created_at, resolved_at FROM aml.alerts WHERE transfer_id = $1 ORDER BY created_at",
        [transferId],
      ),
      this.deps.pool.query<{ outcome: string; rule_results: unknown; risk_score: number; evaluated_at: Date }>(
        "SELECT outcome::text, rule_results, risk_score, evaluated_at FROM aml.transfer_evaluations WHERE transfer_id = $1",
        [transferId],
      ),
    ]);
    const evaluated = evaluation.rows[0];
    return {
      ...presentTransfer(row),
      history: history.rows.map((item) => ({
        from: item.from_status,
        to: item.to_status,
        reason: item.reason,
        actor: { type: item.actor_type, id: item.actor_id },
        at: item.created_at.toISOString(),
      })),
      attempts: attempts.rows.map((attempt) => ({
        id: attempt.id,
        direction: attempt.direction,
        provider: attempt.provider,
        status: attempt.status,
        amountMinor: attempt.amount,
        currency: attempt.currency,
        providerReference: attempt.provider_reference,
        failureCode: attempt.failure_code,
        createdAt: attempt.created_at.toISOString(),
        updatedAt: attempt.updated_at.toISOString(),
      })),
      journals: journals.rows.map((journal) => ({
        id: journal.id,
        seq: journal.seq,
        type: journal.journal_type,
        key: journal.idempotency_key,
        reversesJournalId: journal.reverses_journal_id,
        createdAt: journal.created_at.toISOString(),
      })),
      alerts: alerts.rows.map((alert) => ({
        id: alert.id,
        rule: alert.rule_code,
        severity: alert.severity,
        status: alert.status,
        createdAt: alert.created_at.toISOString(),
        resolvedAt: alert.resolved_at?.toISOString() ?? null,
      })),
      amlEvaluation: evaluated === undefined ? null : { outcome: evaluated.outcome, riskScore: evaluated.risk_score, rules: evaluated.rule_results, evaluatedAt: evaluated.evaluated_at.toISOString() },
    };
  }

  async hold(context: AdminRequestContext, transferId: string, reason: string): Promise<Readonly<Record<string, unknown>>> {
    await this.assertExists(transferId);
    const outcome = await this.deps.orchestrator.holdForReview(transferId, adminActor(context), reason, (client) =>
      recordAdminAudit(client, context, { action: "transfers.held", targetType: "transfer", targetId: transferId, metadata: { reason } }),
    );
    if (outcome !== "held") throw new ConflictError("CONFLICT", "Ce transfert ne peut plus être mis en revue (paiement déjà engagé ou statut incompatible).");
    return this.detail(transferId);
  }

  async release(context: AdminRequestContext, transferId: string, note: string): Promise<Readonly<Record<string, unknown>>> {
    await this.assertExists(transferId);
    const outcome = await this.deps.orchestrator.releaseFromReview(transferId, adminActor(context), note, (client) =>
      recordAdminAudit(client, context, { action: "transfers.released", targetType: "transfer", targetId: transferId, metadata: { note } }),
    );
    if (outcome !== "released") throw new ConflictError("CONFLICT", "Ce transfert n'est pas en revue de conformité.");
    return this.detail(transferId);
  }

  private async assertExists(transferId: string): Promise<void> {
    const found = await this.deps.pool.query("SELECT 1 FROM transfers.transfers WHERE id = $1", [transferId]);
    if (found.rowCount === 0) throw new NotFoundError("Transfert introuvable.");
  }
}
