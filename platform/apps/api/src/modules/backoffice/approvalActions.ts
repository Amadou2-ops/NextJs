import { z } from "zod";

import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { Money, parseCurrencyCode } from "../../lib/money.js";
import { assertBalanced } from "../ledger/ledger.service.js";
import type { LedgerService, Posting } from "../ledger/ledger.service.js";
import type { PaymentOrchestrator } from "../transfers/payment.orchestrator.js";
import { generateInvitationToken } from "./adminAuth.service.js";
import { defineApproval } from "./approvals.service.js";
import type { ApprovalDefinition, ApprovalRegistry, RegisteredApproval } from "./approvals.service.js";

/**
 * Catalogue des actions à double validation et de leur exécution. Chaque
 * action déclare la permission exigée, le type de cible (vérifié par la base
 * au moment de l'exécution) et le schéma strict de son contenu.
 */

export const STAFF_ROLES = ["support", "risk_manager", "super_admin"] as const;

const justificationText = z.string().trim().min(10).max(1000);

/** Plage d'adresses : IPv4 /16 à /32, IPv6 /32 à /128 (jamais « tout Internet »). */
export const allowedIpRangeSchema = z.union([z.cidrv4(), z.cidrv6()]).refine((value) => {
  const prefix = Number(value.split("/")[1]);
  return value.includes(":") ? prefix >= 32 : prefix >= 16;
}, "plage d'adresses trop large");

const rolesSchema = z
  .array(z.enum(STAFF_ROLES))
  .min(1)
  .max(STAFF_ROLES.length)
  .refine((roles) => new Set(roles).size === roles.length, "rôle en double");

export const inviteAdminPayloadSchema = z.strictObject({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  roles: rolesSchema,
  allowedIpRanges: z.array(allowedIpRangeSchema).min(1).max(10),
});

export const grantRolesPayloadSchema = z.strictObject({ roles: rolesSchema });
export const reactivateAdminPayloadSchema = z.strictObject({});
export const adminNetworkPayloadSchema = z.strictObject({ allowedIpRanges: z.array(allowedIpRangeSchema).min(1).max(10) });
export const refundTransferPayloadSchema = z.strictObject({ reason: justificationText });
export const accountStatusPayloadSchema = z.strictObject({ status: z.enum(["frozen", "active"]), reason: justificationText });
export const reverseJournalPayloadSchema = z.strictObject({ reason: justificationText });
export const fileSarPayloadSchema = z.strictObject({ sarReference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{2,99}$/) });
export const ledgerAdjustmentPayloadSchema = z.strictObject({
  description: z.string().trim().min(10).max(500),
  entries: z
    .array(
      z.strictObject({
        accountId: z.uuid(),
        direction: z.enum(["debit", "credit"]),
        amountMinor: z.string().regex(/^[1-9][0-9]{0,17}$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
    )
    .min(2)
    .max(20),
});

type InviteAdminPayload = z.infer<typeof inviteAdminPayloadSchema>;
type LedgerAdjustmentPayload = z.infer<typeof ledgerAdjustmentPayloadSchema>;

function postingsOf(payload: LedgerAdjustmentPayload): Posting[] {
  return payload.entries.map((entry) => ({
    accountId: entry.accountId,
    direction: entry.direction,
    money: Money.ofMinor(BigInt(entry.amountMinor), parseCurrencyCode(entry.currency)),
  }));
}

async function assertAdminExists(db: DatabasePool, adminId: string, statuses: readonly string[]): Promise<void> {
  const result = await db.query("SELECT 1 FROM backoffice.admin_users WHERE id = $1 AND status::text = ANY($2::text[])", [adminId, statuses]);
  if (result.rowCount === 0) throw new NotFoundError("Membre du personnel introuvable ou dans un état incompatible.");
}

export function createApprovalRegistry(deps: {
  readonly admin: AppConfig["admin"];
  readonly ledger: LedgerService;
  readonly orchestrator: PaymentOrchestrator;
}): ApprovalRegistry {
  const inviteAdmin: ApprovalDefinition<InviteAdminPayload> = {
    permission: "admins:manage",
    targetType: "admin_invitation",
    schema: inviteAdminPayloadSchema,
    prepare: async (db, targetId, payload) => {
      if (targetId !== payload.email) throw new ValidationError([{ path: "body.email", message: "cible incohérente" }]);
      const existing = await db.query("SELECT 1 FROM backoffice.admin_users WHERE email = $1", [payload.email]);
      if (existing.rowCount !== 0) throw new ConflictError("CONFLICT", "Un compte existe déjà pour cette adresse.");
    },
    execute: async (client, request) => {
      const invitation = generateInvitationToken();
      const expiresAt = new Date(Date.now() + deps.admin.invitationTtlMs);
      const created = await client.query<{ id: string }>(
        "SELECT backoffice.create_invited_admin($1, $2, $3::cidr[], $4::text[], $5, $6) AS id",
        [request.payload.email, request.payload.fullName, request.payload.allowedIpRanges, request.payload.roles, invitation.sha256, expiresAt],
      );
      const adminId = created.rows[0]?.id;
      if (adminId === undefined) throw new Error("création du compte invité impossible");
      const url = new URL(deps.admin.enrollmentUrl);
      // Fragment : jamais transmis au serveur web ni journalisé par les proxys.
      url.hash = `invitation=${invitation.token}`;
      return { result: { adminId, enrollmentUrl: url.toString(), invitationExpiresAt: expiresAt.toISOString() } };
    },
  };

  const grantRoles: ApprovalDefinition<z.infer<typeof grantRolesPayloadSchema>> = {
    permission: "admins:manage",
    targetType: "admin_user",
    schema: grantRolesPayloadSchema,
    prepare: (db, targetId) => assertAdminExists(db, targetId, ["invited", "active", "suspended"]),
    execute: async (client, request) => {
      for (const role of request.payload.roles) {
        await client.query("SELECT backoffice.grant_role($1, $2)", [request.targetId, role]);
      }
      return { result: { adminId: request.targetId, granted: request.payload.roles } };
    },
  };

  const reactivateAdmin: ApprovalDefinition<z.infer<typeof reactivateAdminPayloadSchema>> = {
    permission: "admins:manage",
    targetType: "admin_user",
    schema: reactivateAdminPayloadSchema,
    prepare: (db, targetId) => assertAdminExists(db, targetId, ["suspended"]),
    execute: async (client, request) => {
      const updated = await client.query("UPDATE backoffice.admin_users SET status = 'active' WHERE id = $1 AND status = 'suspended'", [request.targetId]);
      if (updated.rowCount !== 1) throw new ConflictError("CONFLICT", "Ce compte n'est plus suspendu.");
      return { result: { adminId: request.targetId, status: "active" } };
    },
  };

  const updateAdminNetwork: ApprovalDefinition<z.infer<typeof adminNetworkPayloadSchema>> = {
    permission: "admins:manage",
    targetType: "admin_user",
    schema: adminNetworkPayloadSchema,
    prepare: (db, targetId) => assertAdminExists(db, targetId, ["invited", "active", "suspended"]),
    execute: async (client, request) => {
      await client.query("UPDATE backoffice.admin_users SET allowed_ip_ranges = $2::cidr[] WHERE id = $1", [request.targetId, request.payload.allowedIpRanges]);
      // Les sessions ouvertes depuis un réseau désormais exclu tombent.
      await client.query(
        `UPDATE backoffice.sessions SET revoked_at = now(), revoked_reason = 'network_policy_changed'
          WHERE admin_user_id = $1 AND revoked_at IS NULL AND NOT (ip_address <<= ANY ($2::cidr[]))`,
        [request.targetId, request.payload.allowedIpRanges],
      );
      return { result: { adminId: request.targetId, allowedIpRanges: request.payload.allowedIpRanges } };
    },
  };

  const refundTransfer: ApprovalDefinition<z.infer<typeof refundTransferPayloadSchema>> = {
    permission: "transfers:refund",
    targetType: "transfer",
    schema: refundTransferPayloadSchema,
    prepare: async (db, targetId) => {
      const result = await db.query<{ status: string }>("SELECT status::text FROM transfers.transfers WHERE id = $1", [targetId]);
      const status = result.rows[0]?.status;
      if (status === undefined) throw new NotFoundError("Transfert introuvable.");
      if (!["funded", "payout_pending", "compliance_review", "payout_failed"].includes(status)) {
        throw new ConflictError("CONFLICT", "Ce transfert ne peut plus être remboursé.");
      }
    },
    execute: async (client, request) => {
      const outcome = await deps.orchestrator.orderRefundInTransaction(client, request.targetId, request.payload.reason);
      if (outcome !== "refund_pending") throw new ConflictError("CONFLICT", "Ce transfert ne peut plus être remboursé.");
      return { result: { transferId: request.targetId, status: "refund_pending" }, afterCommit: () => deps.orchestrator.startRefund(request.targetId) };
    },
  };

  const setAccountStatus: ApprovalDefinition<z.infer<typeof accountStatusPayloadSchema>> = {
    permission: "ledger:freeze",
    targetType: "ledger_account",
    schema: accountStatusPayloadSchema,
    prepare: async (db, targetId, payload) => {
      const result = await db.query<{ status: string }>("SELECT status::text FROM ledger.accounts WHERE id = $1", [targetId]);
      const status = result.rows[0]?.status;
      if (status === undefined) throw new NotFoundError("Compte introuvable.");
      if (status === payload.status || status === "closed") throw new ConflictError("CONFLICT", "Le compte est déjà dans cet état.");
    },
    execute: async (client, request) => {
      await client.query("SELECT ledger.set_account_status($1, $2::ledger.account_status, $3)", [request.targetId, request.payload.status, request.payload.reason]);
      return { result: { accountId: request.targetId, status: request.payload.status } };
    },
  };

  const ledgerAdjustment: ApprovalDefinition<LedgerAdjustmentPayload> = {
    permission: "ledger:adjust",
    targetType: "ledger_adjustment",
    schema: ledgerAdjustmentPayloadSchema,
    prepare: async (db, targetId, payload) => {
      if (!/^admin-adjustment:[0-9a-f-]{36}$/.test(targetId)) throw new ValidationError([{ path: "targetId", message: "clé d'ajustement invalide" }]);
      try {
        assertBalanced(postingsOf(payload));
      } catch (error: unknown) {
        throw new ValidationError([{ path: "body.entries", message: error instanceof Error ? error.message : "écriture invalide" }]);
      }
      const accounts = await db.query<{ id: string; currency: string; status: string }>(
        "SELECT id, currency, status::text FROM ledger.accounts WHERE id = ANY($1::uuid[])",
        [payload.entries.map((entry) => entry.accountId)],
      );
      const byId = new Map(accounts.rows.map((row) => [row.id, row]));
      for (const [index, entry] of payload.entries.entries()) {
        const account = byId.get(entry.accountId);
        if (account === undefined) throw new ValidationError([{ path: `body.entries.${index.toString()}.accountId`, message: "compte inconnu" }]);
        if (account.currency !== entry.currency) throw new ValidationError([{ path: `body.entries.${index.toString()}.currency`, message: "devise différente de celle du compte" }]);
        if (account.status === "closed") throw new ValidationError([{ path: `body.entries.${index.toString()}.accountId`, message: "compte clôturé" }]);
      }
    },
    execute: async (client, request, context) => {
      const journalId = await deps.ledger.post(client, {
        idempotencyKey: request.targetId,
        journalType: "adjustment",
        postings: postingsOf(request.payload),
        description: request.payload.description,
        actor: `admin:${context.adminId}`,
        reference: { type: "approval_request", id: request.id },
        metadata: { approval_request_id: request.id },
      });
      return { result: { journalId } };
    },
  };

  const reverseJournal: ApprovalDefinition<z.infer<typeof reverseJournalPayloadSchema>> = {
    permission: "ledger:adjust",
    targetType: "ledger_journal",
    schema: reverseJournalPayloadSchema,
    prepare: async (db, targetId) => {
      const result = await db.query<{ journal_type: string; reversed: boolean }>(
        `SELECT j.journal_type::text,
                EXISTS (SELECT 1 FROM ledger.journals r WHERE r.reverses_journal_id = j.id) AS reversed
           FROM ledger.journals j WHERE j.id = $1`,
        [targetId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new NotFoundError("Journal introuvable.");
      if (row.journal_type === "reversal" || row.reversed) throw new ConflictError("CONFLICT", "Ce journal ne peut pas (ou plus) être contre-passé.");
    },
    execute: async (client, request, context) => {
      const journalId = await deps.ledger.reverse(client, {
        journalId: request.targetId,
        idempotencyKey: `admin-reversal:${request.targetId}`,
        reason: request.payload.reason,
        actor: `admin:${context.adminId}`,
      });
      return { result: { journalId, reversedJournalId: request.targetId } };
    },
  };

  const fileSar: ApprovalDefinition<z.infer<typeof fileSarPayloadSchema>> = {
    permission: "aml:sar:file",
    targetType: "aml_case",
    schema: fileSarPayloadSchema,
    prepare: async (db, targetId) => {
      const result = await db.query<{ status: string }>("SELECT status::text FROM aml.cases WHERE id = $1", [targetId]);
      const status = result.rows[0]?.status;
      if (status === undefined) throw new NotFoundError("Dossier introuvable.");
      if (status !== "investigating") throw new ConflictError("CONFLICT", "Seul un dossier en cours d'instruction peut faire l'objet d'une déclaration.");
    },
    execute: async (client, request) => {
      const updated = await client.query<{ user_id: string }>(
        `UPDATE aml.cases SET status = 'sar_filed', sar_reference = $2, sar_filed_at = now()
          WHERE id = $1 AND status = 'investigating' RETURNING user_id`,
        [request.targetId, request.payload.sarReference],
      );
      const userId = updated.rows[0]?.user_id;
      if (userId === undefined) throw new ConflictError("CONFLICT", "Le dossier n'est plus en cours d'instruction.");
      // Aucune information au client (interdiction de divulgation) : événement interne uniquement.
      await client.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('aml_case', $1, 'aml.sar_filed', $2::jsonb, $3)`,
        [request.targetId, JSON.stringify({ case_id: request.targetId, sar_reference: request.payload.sarReference }), `aml-sar-filed:${request.targetId}`],
      );
      return { result: { caseId: request.targetId, status: "sar_filed" } };
    },
  };

  return new Map<string, RegisteredApproval>([
    ["invite_admin", defineApproval(inviteAdmin)],
    ["grant_roles", defineApproval(grantRoles)],
    ["reactivate_admin", defineApproval(reactivateAdmin)],
    ["update_admin_network", defineApproval(updateAdminNetwork)],
    ["refund_transfer", defineApproval(refundTransfer)],
    ["set_account_status", defineApproval(setAccountStatus)],
    ["ledger_adjustment", defineApproval(ledgerAdjustment)],
    ["reverse_journal", defineApproval(reverseJournal)],
    ["file_sar", defineApproval(fileSar)],
  ]);
}
