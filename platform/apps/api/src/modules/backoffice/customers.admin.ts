import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { normalizeEmail, normalizePhone } from "../../lib/crypto/blindIndex.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import { adminActor, recordAdminAudit } from "./access.js";
import type { AdminRequestContext } from "./access.js";

/**
 * Fiches clients pour le personnel. Par défaut, aucune donnée personnelle en
 * clair : identifiants, statuts, niveau KYC, profil de risque, soldes. Le
 * déchiffrement (customers:read_pii) exige une justification et laisse une
 * trace dans le journal d'audit chaîné.
 */

export interface CustomerSummary {
  readonly id: string;
  readonly customerNumber: string;
  readonly status: string;
  readonly kycTier: string;
  readonly countryOfResidence: string;
  readonly phoneCountry: string;
  readonly riskLevel: string | null;
  readonly createdAt: string;
}

interface SummaryRow {
  id: string;
  customer_number: string;
  status: string;
  kyc_tier: string;
  country_of_residence: string;
  phone_country: string;
  risk_level: string | null;
  created_at: Date;
}

const SUMMARY_SELECT = `
  SELECT u.id, u.customer_number::text, u.status::text, u.kyc_tier::text, u.country_of_residence, u.phone_country,
         p.risk_level::text, u.created_at
    FROM identity.users u
    LEFT JOIN aml.customer_risk_profiles p ON p.user_id = u.id`;

function summary(row: SummaryRow): CustomerSummary {
  return {
    id: row.id,
    customerNumber: row.customer_number,
    status: row.status,
    kycTier: row.kyc_tier,
    countryOfResidence: row.country_of_residence,
    phoneCountry: row.phone_country,
    riskLevel: row.risk_level,
    createdAt: row.created_at.toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CustomersAdminService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly encryptor: FieldEncryptor;
      readonly indexer: BlindIndexer;
    },
  ) {}

  /**
   * Recherche exacte (jamais par sous-chaîne : les coordonnées ne sont
   * consultables que par index aveugle) : numéro client, identifiant,
   * téléphone E.164 ou e-mail.
   */
  async search(params: { readonly query: string | undefined; readonly status: string | undefined; readonly limit: number }): Promise<readonly CustomerSummary[]> {
    const query = params.query?.trim();
    let condition = "true";
    const values: unknown[] = [];
    if (query !== undefined && query.length > 0) {
      if (/^\d{1,18}$/.test(query)) {
        values.push(query);
        condition = `u.customer_number = $${values.length.toString()}::bigint`;
      } else if (UUID_PATTERN.test(query)) {
        values.push(query.toLowerCase());
        condition = `u.id = $${values.length.toString()}::uuid`;
      } else if (query.includes("@")) {
        values.push(this.deps.indexer.compute("email", normalizeEmail(query)));
        condition = `u.email_bidx = $${values.length.toString()}`;
      } else {
        let phone: string;
        try {
          phone = normalizePhone(query).e164;
        } catch {
          return [];
        }
        values.push(this.deps.indexer.compute("phone", phone));
        condition = `u.phone_bidx = $${values.length.toString()}`;
      }
    }
    if (params.status !== undefined) {
      values.push(params.status);
      condition += ` AND u.status::text = $${values.length.toString()}`;
    }
    values.push(params.limit);
    const result = await this.deps.pool.query<SummaryRow>(`${SUMMARY_SELECT} WHERE ${condition} ORDER BY u.created_at DESC LIMIT $${values.length.toString()}`, values);
    return result.rows.map(summary);
  }

  async detail(userId: string): Promise<Readonly<Record<string, unknown>>> {
    const found = await this.deps.pool.query<SummaryRow & { suspended_at: Date | null; last_login_at: Date | null; mfa: boolean; email_verified: boolean }>(
      `SELECT u.id, u.customer_number::text, u.status::text, u.kyc_tier::text, u.country_of_residence, u.phone_country,
              p.risk_level::text, u.created_at, u.suspended_at, u.last_login_at,
              u.mfa_totp_enabled_at IS NOT NULL AS mfa, u.email_verified_at IS NOT NULL AS email_verified
         FROM identity.users u
         LEFT JOIN aml.customer_risk_profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError("Client introuvable.");
    const [profile, verifications, balances, alerts, transfers, cases] = await Promise.all([
      this.deps.pool.query<{ risk_level: string; risk_score: number; is_pep: boolean; is_sanctioned: boolean; enhanced_due_diligence: boolean; factors: Record<string, unknown>; last_assessed_at: Date }>(
        "SELECT risk_level::text, risk_score, is_pep, is_sanctioned, enhanced_due_diligence, factors, last_assessed_at FROM aml.customer_risk_profiles WHERE user_id = $1",
        [userId],
      ),
      this.deps.pool.query<{ id: string; provider: string; tier_requested: string; status: string; created_at: Date; decided_at: Date | null; expires_at: Date | null; manual: boolean }>(
        `SELECT id, provider::text, tier_requested::text, status::text, created_at, decided_at, expires_at, decided_by_admin_id IS NOT NULL AS manual
           FROM kyc.verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      this.deps.pool.query<{ currency: string; available: string; held: string }>(
        `SELECT w.currency, w.balance::text AS available, COALESCE(h.balance, 0)::text AS held
           FROM ledger.accounts wa
           JOIN ledger.account_balances w ON w.account_id = wa.id
           LEFT JOIN ledger.accounts ha ON ha.owner_user_id = wa.owner_user_id AND ha.currency = wa.currency AND ha.account_type = 'customer_hold'
           LEFT JOIN ledger.account_balances h ON h.account_id = ha.id
          WHERE wa.owner_user_id = $1 AND wa.account_type = 'customer_wallet'
          ORDER BY w.currency`,
        [userId],
      ),
      this.deps.pool.query<{ open: string }>(
        "SELECT count(*)::text AS open FROM aml.alerts WHERE user_id = $1 AND status IN ('open', 'under_review', 'escalated')",
        [userId],
      ),
      this.deps.pool.query<{ total: string; in_review: string }>(
        "SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'compliance_review')::text AS in_review FROM transfers.transfers WHERE user_id = $1",
        [userId],
      ),
      this.deps.pool.query<{ id: string; case_number: string; status: string }>(
        "SELECT id, case_number::text, status::text FROM aml.cases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10",
        [userId],
      ),
    ]);
    const risk = profile.rows[0];
    return {
      ...summary(row),
      suspendedAt: row.suspended_at?.toISOString() ?? null,
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
      mfaEnabled: row.mfa,
      emailVerified: row.email_verified,
      riskProfile:
        risk === undefined
          ? null
          : {
              level: risk.risk_level,
              score: risk.risk_score,
              pep: risk.is_pep,
              sanctioned: risk.is_sanctioned,
              enhancedDueDiligence: risk.enhanced_due_diligence,
              factors: risk.factors,
              assessedAt: risk.last_assessed_at.toISOString(),
            },
      verifications: verifications.rows.map((verification) => ({
        id: verification.id,
        provider: verification.provider,
        tier: verification.tier_requested,
        status: verification.status,
        manualDecision: verification.manual,
        createdAt: verification.created_at.toISOString(),
        decidedAt: verification.decided_at?.toISOString() ?? null,
        expiresAt: verification.expires_at?.toISOString() ?? null,
      })),
      wallets: balances.rows.map((balance) => ({ currency: balance.currency, availableMinor: balance.available, heldMinor: balance.held })),
      openAlerts: Number(alerts.rows[0]?.open ?? "0"),
      transfers: { total: Number(transfers.rows[0]?.total ?? "0"), inReview: Number(transfers.rows[0]?.in_review ?? "0") },
      cases: cases.rows.map((item) => ({ id: item.id, caseNumber: item.case_number, status: item.status })),
    };
  }

  /** Données personnelles déchiffrées, sur justification, tracées. */
  async revealPii(context: AdminRequestContext, userId: string, justification: string): Promise<Readonly<Record<string, string | null>>> {
    return withTransaction(this.deps.pool, { actor: adminActor(context) }, async (tx) => {
      const found = await tx.query<{ phone_enc: Buffer; email_enc: Buffer | null; first_name_enc: Buffer | null; last_name_enc: Buffer | null; date_of_birth_enc: Buffer | null }>(
        "SELECT phone_enc, email_enc, first_name_enc, last_name_enc, date_of_birth_enc FROM identity.users WHERE id = $1",
        [userId],
      );
      const row = found.rows[0];
      if (row === undefined) throw new NotFoundError("Client introuvable.");
      const decrypt = async (value: Buffer | null, column: string): Promise<string | null> =>
        value === null ? null : this.deps.encryptor.decrypt(value, fieldContext("identity", "users", column, userId));
      const revealed = {
        phone: await decrypt(row.phone_enc, "phone"),
        email: await decrypt(row.email_enc, "email"),
        firstName: await decrypt(row.first_name_enc, "first_name"),
        lastName: await decrypt(row.last_name_enc, "last_name"),
        dateOfBirth: await decrypt(row.date_of_birth_enc, "date_of_birth"),
      };
      await recordAdminAudit(tx, context, {
        action: "customers.pii_revealed",
        targetType: "user",
        targetId: userId,
        metadata: { justification, fields: Object.entries(revealed).filter(([, value]) => value !== null).map(([field]) => field) },
      });
      return revealed;
    });
  }

  /** Suspension (toutes les sessions tombent) ou rétablissement d'un client. */
  async setStatus(context: AdminRequestContext, userId: string, status: "suspended" | "active", reason: string): Promise<CustomerSummary> {
    await withTransaction(this.deps.pool, { actor: adminActor(context), changeNote: reason }, async (tx) => {
      const current = await tx.query<{ status: string }>("SELECT status::text FROM identity.users WHERE id = $1 FOR UPDATE", [userId]);
      const from = current.rows[0]?.status;
      if (from === undefined) throw new NotFoundError("Client introuvable.");
      if (from === status) throw new ConflictError("CONFLICT", status === "suspended" ? "Ce client est déjà suspendu." : "Ce client est déjà actif.");
      await tx.query("UPDATE identity.users SET status = $2::identity.user_status WHERE id = $1", [userId, status]);
      if (status === "suspended") {
        await tx.query(
          "UPDATE identity.sessions SET revoked_at = now(), revoked_reason = 'account_suspended' WHERE user_id = $1 AND revoked_at IS NULL",
          [userId],
        );
      }
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('user', $1, $2, $3::jsonb, $4)`,
        [userId, status === "suspended" ? "customers.suspended" : "customers.reactivated", JSON.stringify({ user_id: userId }), `customer-status:${userId}:${status}:${context.requestId}`],
      );
      await recordAdminAudit(tx, context, {
        action: status === "suspended" ? "customers.suspended" : "customers.reactivated",
        targetType: "user",
        targetId: userId,
        metadata: { reason, from },
      });
    });
    const [updated] = await this.search({ query: userId, status: undefined, limit: 1 });
    if (updated === undefined) throw new NotFoundError("Client introuvable.");
    return updated;
  }
}
