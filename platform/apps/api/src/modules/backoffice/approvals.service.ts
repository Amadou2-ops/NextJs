import type { Logger } from "pino";
import type { z } from "zod";

import type { AdminPermission } from "../../auth/permissions.js";
import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { TransactionClient } from "../../db/transaction.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { FieldIssue } from "../../lib/errors.js";
import { adminActor, recordAdminAudit } from "./access.js";
import type { AdminRequestContext } from "./access.js";

/**
 * Double validation (règle des quatre yeux).
 *
 * Une action sensible n'est jamais exécutée par celui qui la demande : la
 * demande (contenu figé par empreinte, justification, expiration 24 h) est
 * approuvée par un second membre détenant la même permission, et c'est
 * l'approbateur qui l'exécute, dans la transaction même de l'approbation.
 * La base vérifie chacun de ces points (approval_requests_guard,
 * backoffice.assert_approved) : l'API ne peut pas les contourner.
 *
 * Les effets externes (remboursement chez le prestataire) sont lancés après
 * validation de la transaction.
 */

export interface ApprovalExecution {
  readonly result: Readonly<Record<string, unknown>>;
  readonly afterCommit?: () => Promise<void>;
}

export interface ApprovalDefinition<Payload> {
  readonly permission: AdminPermission;
  readonly targetType: string;
  readonly schema: z.ZodType<Payload>;
  /** Contrôles préalables à la demande (cible existante, état compatible). */
  readonly prepare?: (db: DatabasePool, targetId: string, payload: Payload) => Promise<void>;
  readonly execute: (client: TransactionClient, request: { readonly id: string; readonly targetId: string; readonly payload: Payload }, context: AdminRequestContext) => Promise<ApprovalExecution>;
}

/** Définition enregistrée : le contenu est revalidé par son schéma à chaque usage. */
export interface RegisteredApproval {
  readonly permission: AdminPermission;
  readonly targetType: string;
  validate(payload: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issues: readonly FieldIssue[] };
  prepare(db: DatabasePool, targetId: string, payload: unknown): Promise<void>;
  execute(client: TransactionClient, request: { readonly id: string; readonly targetId: string; readonly payload: unknown }, context: AdminRequestContext): Promise<ApprovalExecution>;
}

export function defineApproval<Payload>(definition: ApprovalDefinition<Payload>): RegisteredApproval {
  return {
    permission: definition.permission,
    targetType: definition.targetType,
    validate: (payload) => {
      const parsed = definition.schema.safeParse(payload);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: ["body", ...issue.path.map(String)].join("."), message: issue.message })) };
    },
    prepare: async (db, targetId, payload) => {
      await definition.prepare?.(db, targetId, definition.schema.parse(payload));
    },
    execute: (client, request, context) => definition.execute(client, { id: request.id, targetId: request.targetId, payload: definition.schema.parse(request.payload) }, context),
  };
}

export type ApprovalRegistry = ReadonlyMap<string, RegisteredApproval>;

export interface ApprovalView {
  readonly id: string;
  readonly permission: string;
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly justification: string;
  readonly status: "pending" | "approved" | "rejected" | "expired" | "executed";
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly requestedAt: string;
  readonly decidedBy: { readonly id: string; readonly name: string } | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly executedAt: string | null;
  readonly expiresAt: string;
}

interface ApprovalRow {
  id: string;
  permission_code: string;
  action_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  justification: string;
  status: ApprovalView["status"];
  effective_status: ApprovalView["status"];
  requested_by_admin_id: string;
  requester_name: string;
  requested_at: Date;
  decided_by_admin_id: string | null;
  decider_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  executed_at: Date | null;
  expires_at: Date;
}

const APPROVAL_SELECT = `
  SELECT r.id, r.permission_code, r.action_type, r.target_type, r.target_id, r.payload, r.justification, r.status,
         CASE WHEN r.status IN ('pending', 'approved') AND r.expires_at <= now() THEN 'expired' ELSE r.status::text END AS effective_status,
         r.requested_by_admin_id, req.full_name AS requester_name, r.requested_at,
         r.decided_by_admin_id, dec.full_name AS decider_name, r.decided_at, r.decision_note, r.executed_at, r.expires_at
    FROM backoffice.approval_requests r
    JOIN backoffice.admin_users req ON req.id = r.requested_by_admin_id
    LEFT JOIN backoffice.admin_users dec ON dec.id = r.decided_by_admin_id`;

function present(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    permission: row.permission_code,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
    justification: row.justification,
    status: row.effective_status,
    requestedBy: { id: row.requested_by_admin_id, name: row.requester_name },
    requestedAt: row.requested_at.toISOString(),
    decidedBy: row.decided_by_admin_id === null ? null : { id: row.decided_by_admin_id, name: row.decider_name ?? "" },
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    executedAt: row.executed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  };
}

export class ApprovalService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly registry: ApprovalRegistry,
    private readonly logger: Logger,
  ) {}

  async request(
    context: AdminRequestContext,
    params: { readonly actionType: string; readonly targetId: string; readonly payload: unknown; readonly justification: string },
  ): Promise<ApprovalView> {
    const definition = this.registry.get(params.actionType);
    if (definition === undefined) throw new ValidationError([{ path: "body.actionType", message: "action inconnue" }]);
    const parsed = definition.validate(params.payload);
    if (!parsed.ok) throw new ValidationError(parsed.issues);
    await definition.prepare(this.pool, params.targetId, parsed.value);

    const id = await withTransaction(this.pool, { actor: adminActor(context) }, async (tx) => {
      // Une seule demande en cours par action et par cible.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`approval:${params.actionType}:${params.targetId}`]);
      const pending = await tx.query(
        `SELECT 1 FROM backoffice.approval_requests
          WHERE action_type = $1 AND target_type = $2 AND target_id = $3 AND status IN ('pending', 'approved') AND expires_at > now()`,
        [params.actionType, definition.targetType, params.targetId],
      );
      if (pending.rowCount !== 0) throw new ConflictError("CONFLICT", "Une demande identique est déjà en attente de validation.");
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload, payload_sha256,
                                                  justification, requested_by_admin_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, sha256(convert_to($5::jsonb::text, 'UTF8')), $6, $7)
         RETURNING id`,
        [definition.permission, params.actionType, definition.targetType, params.targetId, JSON.stringify(parsed.value), params.justification, context.adminId],
      );
      const requestId = inserted.rows[0]?.id;
      if (requestId === undefined) throw new Error("création de la demande impossible");
      await recordAdminAudit(tx, context, {
        action: "approval.requested",
        targetType: "approval_request",
        targetId: requestId,
        metadata: { action_type: params.actionType, target_type: definition.targetType, target_id: params.targetId },
      });
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('approval_request', $1, 'backoffice.approval_requested', $2::jsonb, $3)`,
        [requestId, JSON.stringify({ action_type: params.actionType, permission: definition.permission }), `approval-requested:${requestId}`],
      );
      return requestId;
    });
    return this.get(id);
  }

  async list(filter: { readonly status?: ApprovalView["status"] | undefined; readonly limit: number }): Promise<readonly ApprovalView[]> {
    const result = await this.pool.query<ApprovalRow>(
      `${APPROVAL_SELECT}
        WHERE ($1::text IS NULL
               OR ($1 = 'expired' AND r.status IN ('pending', 'approved', 'expired') AND (r.status = 'expired' OR r.expires_at <= now()))
               OR ($1 IN ('pending', 'approved') AND r.status::text = $1 AND r.expires_at > now())
               OR ($1 NOT IN ('pending', 'approved', 'expired') AND r.status::text = $1))
        ORDER BY r.requested_at DESC
        LIMIT $2`,
      [filter.status ?? null, filter.limit],
    );
    return result.rows.map(present);
  }

  async get(id: string): Promise<ApprovalView> {
    const result = await this.pool.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE r.id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Demande introuvable.");
    return present(row);
  }

  async approve(context: AdminRequestContext, id: string, note: string | undefined): Promise<{ readonly approval: ApprovalView; readonly result: Readonly<Record<string, unknown>> }> {
    const outcome = await withTransaction(this.pool, { actor: adminActor(context), approvalRequestId: id }, async (tx) => {
      const locked = await tx.query<{ action_type: string; target_id: string; payload: Record<string, unknown>; status: string; requested_by_admin_id: string; expired: boolean }>(
        `SELECT action_type, target_id, payload, status::text, requested_by_admin_id, expires_at <= now() AS expired
           FROM backoffice.approval_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new NotFoundError("Demande introuvable.");
      if (row.status !== "pending") throw new ConflictError("CONFLICT", "Cette demande a déjà été traitée.");
      if (row.expired) throw new AppError("VERIFICATION_EXPIRED", 410, "Demande expirée", { detail: "La demande a expiré : elle doit être renouvelée." });
      if (row.requested_by_admin_id === context.adminId) {
        throw new ForbiddenError("Le demandeur ne peut pas approuver sa propre demande.", { reason: "four_eyes" });
      }
      const definition = this.registry.get(row.action_type);
      if (definition === undefined) throw new Error(`action d'approbation sans exécuteur : ${row.action_type}`);

      await tx.query(
        "UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = $2, decision_note = $3 WHERE id = $1",
        [id, context.adminId, note ?? null],
      );
      const execution = await definition.execute(tx, { id, targetId: row.target_id, payload: row.payload }, context);
      await tx.query("UPDATE backoffice.approval_requests SET status = 'executed' WHERE id = $1", [id]);
      await recordAdminAudit(tx, context, {
        action: "approval.executed",
        targetType: "approval_request",
        targetId: id,
        metadata: { action_type: row.action_type, target_id: row.target_id, requested_by: row.requested_by_admin_id },
      });
      return execution;
    });
    if (outcome.afterCommit !== undefined) {
      try {
        await outcome.afterCommit();
      } catch (error: unknown) {
        // L'opération approuvée est validée ; sa suite est reprise par les workers.
        this.logger.error({ err: error, approvalId: id }, "suite de l'action approuvée en échec, reprise par le worker");
      }
    }
    return { approval: await this.get(id), result: outcome.result };
  }

  async reject(context: AdminRequestContext, id: string, note: string): Promise<ApprovalView> {
    await withTransaction(this.pool, { actor: adminActor(context) }, async (tx) => {
      const locked = await tx.query<{ status: string; requested_by_admin_id: string }>(
        "SELECT status::text, requested_by_admin_id FROM backoffice.approval_requests WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new NotFoundError("Demande introuvable.");
      if (row.status !== "pending") throw new ConflictError("CONFLICT", "Cette demande a déjà été traitée.");
      if (row.requested_by_admin_id === context.adminId) {
        throw new ForbiddenError("Le demandeur ne peut pas statuer sur sa propre demande.", { reason: "four_eyes" });
      }
      await tx.query(
        "UPDATE backoffice.approval_requests SET status = 'rejected', decided_by_admin_id = $2, decision_note = $3 WHERE id = $1",
        [id, context.adminId, note],
      );
      await recordAdminAudit(tx, context, { action: "approval.rejected", targetType: "approval_request", targetId: id });
    });
    return this.get(id);
  }

  /** Marque expirées les demandes dépassées (worker de maintenance). */
  async expireStale(): Promise<number> {
    const result = await withTransaction(this.pool, { actor: { type: "system", id: "approvals" } }, (tx) =>
      tx.query("UPDATE backoffice.approval_requests SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= now()"),
    );
    return result.rowCount ?? 0;
  }
}
