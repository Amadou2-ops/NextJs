import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { adminActor, recordAdminAudit } from "./access.js";
import type { AdminRequestContext } from "./access.js";
import { generateInvitationToken } from "./adminAuth.service.js";

/**
 * Personnel et journal d'audit. Les actions qui accordent des droits
 * (invitation, rôle, réactivation, réseau) passent par la double validation ;
 * celles qui en retirent (suspension, désactivation, retrait de rôle) sont
 * immédiates, au nom d'un membre habilité.
 */

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  roles: string[];
  allowed_ip_ranges: string[];
  last_login_at: Date | null;
  created_at: Date;
  security_keys: string;
}

const STAFF_SELECT = `
  SELECT u.id, u.email, u.full_name, u.status::text, u.allowed_ip_ranges::text[] AS allowed_ip_ranges, u.last_login_at, u.created_at,
         COALESCE(array_agg(DISTINCT r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles,
         (SELECT count(*) FROM backoffice.webauthn_credentials c WHERE c.admin_user_id = u.id AND c.revoked_at IS NULL)::text AS security_keys
    FROM backoffice.admin_users u
    LEFT JOIN backoffice.admin_user_roles r ON r.admin_user_id = u.id AND r.revoked_at IS NULL`;

function presentStaff(row: StaffRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    roles: [...row.roles].sort(),
    allowedIpRanges: row.allowed_ip_ranges,
    securityKeys: Number(row.security_keys),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class StaffAdminService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly admin: AppConfig["admin"];
    },
  ) {}

  async me(adminId: string): Promise<Readonly<Record<string, unknown>>> {
    const staff = await this.get(adminId);
    const permissions = await this.deps.pool.query<{ permission_code: string; requires_four_eyes: boolean }>(
      "SELECT permission_code, requires_four_eyes FROM backoffice.effective_permissions WHERE admin_user_id = $1 ORDER BY permission_code",
      [adminId],
    );
    return {
      ...staff,
      permissions: permissions.rows.map((row) => row.permission_code),
      fourEyesPermissions: permissions.rows.filter((row) => row.requires_four_eyes).map((row) => row.permission_code),
    };
  }

  async list(filter: { readonly status?: string | undefined }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.deps.pool.query<StaffRow>(
      `${STAFF_SELECT} WHERE ($1::text IS NULL OR u.status::text = $1) GROUP BY u.id ORDER BY u.full_name`,
      [filter.status ?? null],
    );
    return result.rows.map(presentStaff);
  }

  async get(adminId: string): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.deps.pool.query<StaffRow>(`${STAFF_SELECT} WHERE u.id = $1 GROUP BY u.id`, [adminId]);
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Membre du personnel introuvable.");
    return presentStaff(row);
  }

  /** Suspension ou désactivation définitive : sessions et clés tombent immédiatement. */
  async restrict(context: AdminRequestContext, adminId: string, status: "suspended" | "disabled", reason: string): Promise<Readonly<Record<string, unknown>>> {
    if (adminId === context.adminId) throw new ForbiddenError("Un membre ne peut pas restreindre son propre compte.", { reason: "self_restriction" });
    await withTransaction(this.deps.pool, { actor: adminActor(context), changeNote: reason }, async (tx) => {
      const current = await tx.query<{ status: string }>("SELECT status::text FROM backoffice.admin_users WHERE id = $1 FOR UPDATE", [adminId]);
      const from = current.rows[0]?.status;
      if (from === undefined) throw new NotFoundError("Membre du personnel introuvable.");
      if (from === "disabled" || from === status) throw new ConflictError("CONFLICT", "Ce compte est déjà dans cet état.");
      await tx.query(
        "UPDATE backoffice.admin_users SET status = $2::backoffice.admin_status, disabled_at = CASE WHEN $2 = 'disabled' THEN now() ELSE disabled_at END WHERE id = $1",
        [adminId, status],
      );
      await tx.query(
        "UPDATE backoffice.sessions SET revoked_at = now(), revoked_reason = $2 WHERE admin_user_id = $1 AND revoked_at IS NULL",
        [adminId, `account_${status}`],
      );
      if (status === "disabled") {
        await tx.query("UPDATE backoffice.webauthn_credentials SET revoked_at = now() WHERE admin_user_id = $1 AND revoked_at IS NULL", [adminId]);
        await tx.query("UPDATE backoffice.invitations SET revoked_at = now() WHERE admin_user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [adminId]);
      }
      await recordAdminAudit(tx, context, { action: `backoffice.admin_${status}`, targetType: "admin_user", targetId: adminId, metadata: { reason, from } });
    });
    return this.get(adminId);
  }

  async revokeRole(context: AdminRequestContext, adminId: string, role: string, reason: string): Promise<Readonly<Record<string, unknown>>> {
    await withTransaction(this.deps.pool, { actor: adminActor(context), changeNote: reason }, async (tx) => {
      const updated = await tx.query(
        `UPDATE backoffice.admin_user_roles SET revoked_at = now(), revoked_by_admin_id = $3
          WHERE admin_user_id = $1 AND role_code = $2 AND revoked_at IS NULL`,
        [adminId, role, context.adminId],
      );
      if (updated.rowCount === 0) throw new NotFoundError("Ce membre ne détient pas ce rôle.");
      await recordAdminAudit(tx, context, { action: "backoffice.role_revoked", targetType: "admin_user", targetId: adminId, metadata: { role, reason } });
    });
    return this.get(adminId);
  }

  /** Nouvelle invitation pour un compte encore invité (la précédente est révoquée). */
  async renewInvitation(context: AdminRequestContext, adminId: string): Promise<{ readonly enrollmentUrl: string; readonly invitationExpiresAt: string }> {
    const invitation = generateInvitationToken();
    const expiresAt = new Date(Date.now() + this.deps.admin.invitationTtlMs);
    await withTransaction(this.deps.pool, { actor: adminActor(context) }, async (tx) => {
      await tx.query("SELECT backoffice.renew_invitation($1, $2, $3)", [adminId, invitation.sha256, expiresAt]);
      await recordAdminAudit(tx, context, { action: "backoffice.invitation_renewed", targetType: "admin_user", targetId: adminId });
    });
    const url = new URL(this.deps.admin.enrollmentUrl);
    url.hash = `invitation=${invitation.token}`;
    return { enrollmentUrl: url.toString(), invitationExpiresAt: expiresAt.toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Journal d'audit
  // ---------------------------------------------------------------------------

  async auditEvents(filter: {
    readonly actorId?: string | undefined;
    readonly targetType?: string | undefined;
    readonly targetId?: string | undefined;
    readonly action?: string | undefined;
    readonly beforeId?: string | undefined;
    readonly limit: number;
  }): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[]; readonly nextCursor: string | null }> {
    const result = await this.deps.pool.query<{
      id: string;
      occurred_at: Date;
      actor_type: string;
      actor_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      ip_address: string | null;
      request_id: string | null;
      metadata: Record<string, unknown>;
      hash: Buffer;
    }>(
      `SELECT id::text, occurred_at, actor_type::text, actor_id, action, target_type, target_id, host(ip_address) AS ip_address,
              request_id, metadata, hash
         FROM audit.events
        WHERE ($1::text IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR target_type = $2)
          AND ($3::text IS NULL OR target_id = $3)
          AND ($4::text IS NULL OR action = $4)
          AND ($5::bigint IS NULL OR id < $5)
        ORDER BY id DESC
        LIMIT $6`,
      [filter.actorId ?? null, filter.targetType ?? null, filter.targetId ?? null, filter.action ?? null, filter.beforeId ?? null, filter.limit + 1],
    );
    const rows = result.rows.slice(0, filter.limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        actor: { type: row.actor_type, id: row.actor_id },
        action: row.action,
        target: row.target_type === null ? null : { type: row.target_type, id: row.target_id },
        ipAddress: row.ip_address,
        requestId: row.request_id,
        metadata: row.metadata,
        hash: row.hash.toString("hex"),
      })),
      nextCursor: result.rows.length > filter.limit ? (rows.at(-1)?.id ?? null) : null,
    };
  }

  async auditIntegrity(): Promise<{ readonly intact: boolean; readonly problems: readonly { readonly eventId: string; readonly problem: string }[]; readonly lastEventId: string | null }> {
    const problems = await this.deps.pool.query<{ event_id: string; problem: string }>("SELECT event_id::text, problem FROM audit.verify_chain() LIMIT 100");
    const head = await this.deps.pool.query<{ last_id: string | null }>("SELECT max(id)::text AS last_id FROM audit.events");
    return {
      intact: problems.rows.length === 0,
      problems: problems.rows.map((row) => ({ eventId: row.event_id, problem: row.problem })),
      lastEventId: head.rows[0]?.last_id ?? null,
    };
  }
}
