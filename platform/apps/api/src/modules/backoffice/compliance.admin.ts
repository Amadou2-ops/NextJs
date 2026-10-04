import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { TransactionClient } from "../../db/transaction.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { adminActor, recordAdminAudit } from "./access.js";
import type { AdminRequestContext } from "./access.js";

/**
 * Conformité : revue manuelle KYC, traitement des alertes AML et dossiers
 * d'enquête. Chaque décision est prise au nom d'un membre identifié ; la base
 * revérifie sa permission (migration 0023) et historise la décision.
 */

export type KycDecision = "approve" | "reject" | "resubmission_required";

interface VerificationRow {
  id: string;
  user_id: string;
  customer_number: string;
  provider: string;
  job_type: string;
  tier_requested: string;
  status: string;
  provider_result: Record<string, unknown>;
  rejection_reasons: string[];
  liveness_score: string | null;
  document_match_score: string | null;
  submitted_at: Date | null;
  created_at: Date;
}

const VERIFICATION_SELECT = `
  SELECT v.id, v.user_id, u.customer_number::text, v.provider::text, v.job_type::text, v.tier_requested::text, v.status::text,
         v.provider_result, v.rejection_reasons, v.liveness_score::text, v.document_match_score::text, v.submitted_at, v.created_at
    FROM kyc.verifications v
    JOIN identity.users u ON u.id = v.user_id`;

function presentVerification(row: VerificationRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    userId: row.user_id,
    customerNumber: row.customer_number,
    provider: row.provider,
    jobType: row.job_type,
    tier: row.tier_requested,
    status: row.status,
    review: row.provider_result["review"] ?? null,
    reasons: row.rejection_reasons,
    livenessScore: row.liveness_score,
    documentMatchScore: row.document_match_score,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

interface AlertRow {
  id: string;
  user_id: string;
  customer_number: string;
  transfer_id: string | null;
  transfer_reference: string | null;
  rule_code: string;
  rule_description: string;
  blocks_transfer: boolean;
  severity: string;
  score: number;
  status: string;
  details: Record<string, unknown>;
  assigned_to_admin_id: string | null;
  assignee_name: string | null;
  resolution_note: string | null;
  resolved_by_admin_id: string | null;
  screening_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

const ALERT_SELECT = `
  SELECT a.id, a.user_id, u.customer_number::text, a.transfer_id, t.reference AS transfer_reference, a.rule_code,
         r.description AS rule_description, r.blocks_transfer, a.severity::text, a.score, a.status::text, a.details,
         a.assigned_to_admin_id, adm.full_name AS assignee_name, a.resolution_note, a.resolved_by_admin_id, a.screening_id,
         a.created_at, a.resolved_at
    FROM aml.alerts a
    JOIN aml.rules r ON r.code = a.rule_code
    JOIN identity.users u ON u.id = a.user_id
    LEFT JOIN transfers.transfers t ON t.id = a.transfer_id
    LEFT JOIN backoffice.admin_users adm ON adm.id = a.assigned_to_admin_id`;

function presentAlert(row: AlertRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    userId: row.user_id,
    customerNumber: row.customer_number,
    transferId: row.transfer_id,
    transferReference: row.transfer_reference,
    rule: { code: row.rule_code, description: row.rule_description, blocksTransfer: row.blocks_transfer },
    severity: row.severity,
    score: row.score,
    status: row.status,
    details: row.details,
    assignee: row.assigned_to_admin_id === null ? null : { id: row.assigned_to_admin_id, name: row.assignee_name ?? "" },
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by_admin_id,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

const OPEN_ALERT_STATUSES = ["open", "under_review", "escalated"];

export class ComplianceAdminService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly encryptor: FieldEncryptor;
      readonly verificationValidityDays: number;
    },
  ) {}

  // ---------------------------------------------------------------------------
  // KYC
  // ---------------------------------------------------------------------------

  async kycQueue(limit: number): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.deps.pool.query<VerificationRow>(
      `${VERIFICATION_SELECT} WHERE v.status = 'in_review' ORDER BY v.submitted_at NULLS LAST, v.created_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(presentVerification);
  }

  /** Détail d'une vérification ; la pièce n'est déchiffrée qu'avec customers:read_pii. */
  async kycDetail(context: AdminRequestContext, verificationId: string, revealIdentity: boolean): Promise<Readonly<Record<string, unknown>>> {
    const found = await this.deps.pool.query<VerificationRow>(`${VERIFICATION_SELECT} WHERE v.id = $1`, [verificationId]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError("Vérification introuvable.");
    const [evidence, history, duplicates] = await Promise.all([
      this.deps.pool.query<{ document_type: string | null; issuing_country: string | null; declared_identity_match: boolean | null; full_name_enc: Buffer | null; date_of_birth_enc: Buffer | null }>(
        "SELECT document_type::text, issuing_country, declared_identity_match, full_name_enc, date_of_birth_enc FROM kyc.identity_evidence WHERE verification_id = $1",
        [verificationId],
      ),
      this.deps.pool.query<{ from_status: string | null; to_status: string; actor_type: string; actor_id: string | null; note: string | null; created_at: Date }>(
        "SELECT from_status::text, to_status::text, actor_type::text, actor_id, note, created_at FROM kyc.review_events WHERE verification_id = $1 ORDER BY id",
        [verificationId],
      ),
      this.deps.pool.query<{ other_users: string }>(
        `SELECT count(DISTINCT other.user_id)::text AS other_users
           FROM kyc.identity_evidence mine
           JOIN kyc.identity_evidence other ON other.document_number_bidx = mine.document_number_bidx AND other.user_id <> mine.user_id
          WHERE mine.verification_id = $1 AND mine.document_number_bidx IS NOT NULL`,
        [verificationId],
      ),
    ]);
    const proof = evidence.rows[0];
    let identity: Readonly<Record<string, string | null>> | null = null;
    if (revealIdentity && proof !== undefined) {
      const decrypt = async (value: Buffer | null, column: string): Promise<string | null> =>
        value === null ? null : this.deps.encryptor.decrypt(value, fieldContext("kyc", "identity_evidence", column, verificationId));
      identity = { fullName: await decrypt(proof.full_name_enc, "full_name"), dateOfBirth: await decrypt(proof.date_of_birth_enc, "date_of_birth") };
      await withTransaction(this.deps.pool, { actor: adminActor(context) }, (tx) =>
        recordAdminAudit(tx, context, { action: "kyc.evidence_revealed", targetType: "kyc_verification", targetId: verificationId }),
      );
    }
    return {
      ...presentVerification(row),
      evidence:
        proof === undefined
          ? null
          : {
              documentType: proof.document_type,
              issuingCountry: proof.issuing_country,
              declaredIdentityMatch: proof.declared_identity_match,
              documentSharedWithOtherCustomers: Number(duplicates.rows[0]?.other_users ?? "0"),
              identity,
            },
      history: history.rows.map((event) => ({
        from: event.from_status,
        to: event.to_status,
        actor: { type: event.actor_type, id: event.actor_id },
        note: event.note,
        at: event.created_at.toISOString(),
      })),
    };
  }

  async decideKyc(
    context: AdminRequestContext,
    verificationId: string,
    params: { readonly decision: KycDecision; readonly reasons: readonly string[]; readonly note: string },
  ): Promise<Readonly<Record<string, unknown>>> {
    if (params.decision !== "approve" && params.reasons.length === 0) {
      throw new ValidationError([{ path: "body.reasons", message: "un refus ou une demande de nouvelle pièce est motivé" }]);
    }
    await withTransaction(this.deps.pool, { actor: adminActor(context), changeNote: params.note }, async (tx) => {
      const locked = await tx.query<{ user_id: string; status: string; tier_requested: string; provider: string }>(
        "SELECT user_id, status::text, tier_requested::text, provider::text FROM kyc.verifications WHERE id = $1 FOR UPDATE",
        [verificationId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new NotFoundError("Vérification introuvable.");
      if (row.status !== "in_review" && row.status !== "submitted") throw new ConflictError("CONFLICT", "Cette vérification n'attend pas de décision.");
      const status = params.decision === "approve" ? "approved" : params.decision === "reject" ? "rejected" : "resubmission_required";
      await tx.query(
        `UPDATE kyc.verifications
            SET status = $2::kyc.verification_status,
                decided_by_admin_id = $3::uuid,
                decided_at = CASE WHEN $2::text IN ('approved', 'rejected') THEN now() ELSE decided_at END,
                expires_at = CASE WHEN $2::text = 'approved' THEN now() + make_interval(days => $4) ELSE expires_at END,
                rejection_reasons = $5::text[],
                provider_result = provider_result || jsonb_build_object('review', 'manual', 'reviewed_by', $3::text)
          WHERE id = $1`,
        [verificationId, status, context.adminId, this.deps.verificationValidityDays, params.reasons],
      );
      const eventType = status === "approved" ? "kyc.verification_approved" : status === "rejected" ? "kyc.verification_rejected" : "kyc.resubmission_required";
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('kyc_verification', $1, $2, $3::jsonb, $4)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          verificationId,
          eventType,
          JSON.stringify({ verification_id: verificationId, user_id: row.user_id, tier: row.tier_requested, provider: row.provider, reasons: params.reasons, manual: true }),
          `${eventType}:${verificationId}`,
        ],
      );
      await recordAdminAudit(tx, context, {
        action: "kyc.manual_decision",
        targetType: "kyc_verification",
        targetId: verificationId,
        metadata: { decision: params.decision, reasons: params.reasons },
      });
    });
    return this.kycDetail(context, verificationId, false);
  }

  // ---------------------------------------------------------------------------
  // Alertes AML
  // ---------------------------------------------------------------------------

  async alerts(filter: { readonly status?: string | undefined; readonly severity?: string | undefined; readonly assignedToMe?: boolean | undefined; readonly adminId: string; readonly limit: number }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.deps.pool.query<AlertRow>(
      `${ALERT_SELECT}
        WHERE ($1::text IS NULL OR a.status::text = $1)
          AND ($1::text IS NOT NULL OR a.status IN ('open', 'under_review', 'escalated'))
          AND ($2::text IS NULL OR a.severity::text = $2)
          AND (NOT $3 OR a.assigned_to_admin_id = $4)
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, a.created_at
        LIMIT $5`,
      [filter.status ?? null, filter.severity ?? null, filter.assignedToMe === true, filter.adminId, filter.limit],
    );
    return result.rows.map(presentAlert);
  }

  async alertDetail(alertId: string): Promise<Readonly<Record<string, unknown>>> {
    const found = await this.deps.pool.query<AlertRow>(`${ALERT_SELECT} WHERE a.id = $1`, [alertId]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError("Alerte introuvable.");
    let screening: Readonly<Record<string, unknown>> | null = null;
    if (row.screening_id !== null) {
      const result = await this.deps.pool.query<{ subject_type: string; status: string; list_versions: unknown; match_details: unknown; screened_at: Date }>(
        "SELECT subject_type::text, status::text, list_versions, match_details, screened_at FROM aml.screenings WHERE id = $1",
        [row.screening_id],
      );
      const found = result.rows[0];
      if (found !== undefined) {
        screening = { subject: found.subject_type, status: found.status, lists: found.list_versions, matches: found.match_details, screenedAt: found.screened_at.toISOString() };
      }
    }
    return { ...presentAlert(row), screening };
  }

  async assignAlert(context: AdminRequestContext, alertId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.updateAlert(context, alertId, "aml.alert_assigned", {}, async (tx) => {
      await tx.query(
        "UPDATE aml.alerts SET assigned_to_admin_id = $2, status = CASE WHEN status = 'open' THEN 'under_review'::aml.alert_status ELSE status END WHERE id = $1",
        [alertId, context.adminId],
      );
    });
    return this.alertDetail(alertId);
  }

  async escalateAlert(context: AdminRequestContext, alertId: string, note: string): Promise<Readonly<Record<string, unknown>>> {
    await this.updateAlert(context, alertId, "aml.alert_escalated", { note }, async (tx) => {
      await tx.query("UPDATE aml.alerts SET status = 'escalated' WHERE id = $1", [alertId]);
    });
    return this.alertDetail(alertId);
  }

  /**
   * Clôture d'une alerte. Une correspondance de sanctions confirmée sur le
   * client gèle son profil (plus aucun transfert, AM001) ; ses transferts
   * restent bloqués en revue jusqu'à décision (remboursement sous double
   * validation ou conservation des fonds sur instruction des autorités).
   */
  async resolveAlert(context: AdminRequestContext, alertId: string, params: { readonly outcome: "false_positive" | "confirmed"; readonly note: string }): Promise<Readonly<Record<string, unknown>>> {
    await this.updateAlert(context, alertId, "aml.alert_resolved", { outcome: params.outcome }, async (tx, alert) => {
      await tx.query(
        `UPDATE aml.alerts
            SET status = $2::aml.alert_status, resolved_by_admin_id = $3, resolution_note = $4,
                assigned_to_admin_id = COALESCE(assigned_to_admin_id, $3)
          WHERE id = $1`,
        [alertId, params.outcome === "confirmed" ? "closed_confirmed" : "closed_false_positive", context.adminId, params.note],
      );
      if (alert.screening_id !== null) {
        await tx.query(
          `UPDATE aml.screenings SET status = $2::aml.screening_status, reviewed_by_admin_id = $3, reviewed_at = now(), review_note = $4
            WHERE id = $1 AND status = 'potential_match'`,
          [alert.screening_id, params.outcome === "confirmed" ? "confirmed_match" : "false_positive", context.adminId, params.note],
        );
      }
      if (params.outcome === "confirmed" && alert.rule_code === "SANCTIONS_POTENTIAL_MATCH" && alert.subject_type === "user") {
        await tx.query(
          `INSERT INTO aml.customer_risk_profiles (user_id, risk_level, risk_score, is_sanctioned, factors)
           VALUES ($1, 'unacceptable', 100, true, jsonb_build_object('sanctions_confirmed_by', $2::text))
           ON CONFLICT (user_id) DO UPDATE
              SET risk_level = 'unacceptable', risk_score = 100, is_sanctioned = true,
                  factors = aml.customer_risk_profiles.factors || jsonb_build_object('sanctions_confirmed_by', $2::text),
                  last_assessed_at = now()`,
          [alert.user_id, context.adminId],
        );
      }
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('aml_alert', $1, 'aml.alert_resolved', $2::jsonb, $3)`,
        [alertId, JSON.stringify({ alert_id: alertId, outcome: params.outcome, transfer_id: alert.transfer_id }), `aml-alert-resolved:${alertId}`],
      );
    });
    return this.alertDetail(alertId);
  }

  private async updateAlert(
    context: AdminRequestContext,
    alertId: string,
    action: string,
    metadata: Readonly<Record<string, unknown>>,
    body: (tx: TransactionClient, alert: { readonly user_id: string; readonly transfer_id: string | null; readonly rule_code: string; readonly screening_id: string | null; readonly subject_type: string | null }) => Promise<void>,
  ): Promise<void> {
    await withTransaction(this.deps.pool, { actor: adminActor(context) }, async (tx) => {
      const locked = await tx.query<{ user_id: string; transfer_id: string | null; rule_code: string; screening_id: string | null; status: string; subject_type: string | null }>(
        `SELECT a.user_id, a.transfer_id, a.rule_code, a.screening_id, a.status::text, s.subject_type::text
           FROM aml.alerts a LEFT JOIN aml.screenings s ON s.id = a.screening_id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [alertId],
      );
      const alert = locked.rows[0];
      if (alert === undefined) throw new NotFoundError("Alerte introuvable.");
      if (!OPEN_ALERT_STATUSES.includes(alert.status)) throw new ConflictError("CONFLICT", "Cette alerte est déjà close.");
      await body(tx, alert);
      await recordAdminAudit(tx, context, { action, targetType: "aml_alert", targetId: alertId, metadata });
    });
  }

  // ---------------------------------------------------------------------------
  // Dossiers d'enquête
  // ---------------------------------------------------------------------------

  async cases(filter: { readonly status?: string | undefined; readonly limit: number }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.deps.pool.query<{ id: string; case_number: string; user_id: string; status: string; summary: string; assigned_to_admin_id: string | null; created_at: Date; alerts: string }>(
      `SELECT c.id, c.case_number::text, c.user_id, c.status::text, c.summary, c.assigned_to_admin_id, c.created_at,
              (SELECT count(*) FROM aml.case_alerts ca WHERE ca.case_id = c.id)::text AS alerts
         FROM aml.cases c
        WHERE ($1::text IS NULL AND c.status <> 'closed') OR c.status::text = $1
        ORDER BY c.created_at DESC LIMIT $2`,
      [filter.status ?? null, filter.limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      caseNumber: row.case_number,
      userId: row.user_id,
      status: row.status,
      summary: row.summary,
      assignedTo: row.assigned_to_admin_id,
      alertCount: Number(row.alerts),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async caseDetail(caseId: string): Promise<Readonly<Record<string, unknown>>> {
    const found = await this.deps.pool.query<{
      id: string;
      case_number: string;
      user_id: string;
      status: string;
      summary: string;
      opened_by_admin_id: string;
      assigned_to_admin_id: string | null;
      sar_reference: string | null;
      sar_filed_at: Date | null;
      closure_note: string | null;
      created_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT id, case_number::text, user_id, status::text, summary, opened_by_admin_id, assigned_to_admin_id, sar_reference,
              sar_filed_at, closure_note, created_at, closed_at
         FROM aml.cases WHERE id = $1`,
      [caseId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError("Dossier introuvable.");
    const alerts = await this.deps.pool.query<AlertRow>(`${ALERT_SELECT} JOIN aml.case_alerts ca ON ca.alert_id = a.id WHERE ca.case_id = $1 ORDER BY a.created_at`, [caseId]);
    return {
      id: row.id,
      caseNumber: row.case_number,
      userId: row.user_id,
      status: row.status,
      summary: row.summary,
      openedBy: row.opened_by_admin_id,
      assignedTo: row.assigned_to_admin_id,
      sarReference: row.sar_reference,
      sarFiledAt: row.sar_filed_at?.toISOString() ?? null,
      closureNote: row.closure_note,
      createdAt: row.created_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
      alerts: alerts.rows.map(presentAlert),
    };
  }

  async openCase(context: AdminRequestContext, params: { readonly userId: string; readonly summary: string; readonly alertIds: readonly string[] }): Promise<Readonly<Record<string, unknown>>> {
    const caseId = await withTransaction(this.deps.pool, { actor: adminActor(context) }, async (tx) => {
      const user = await tx.query("SELECT 1 FROM identity.users WHERE id = $1", [params.userId]);
      if (user.rowCount === 0) throw new NotFoundError("Client introuvable.");
      const created = await tx.query<{ id: string }>(
        "INSERT INTO aml.cases (user_id, summary, opened_by_admin_id, assigned_to_admin_id) VALUES ($1, $2, $3, $3) RETURNING id",
        [params.userId, params.summary, context.adminId],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw new Error("ouverture du dossier impossible");
      for (const alertId of params.alertIds) {
        await tx.query("INSERT INTO aml.case_alerts (case_id, alert_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, alertId]);
      }
      await recordAdminAudit(tx, context, { action: "aml.case_opened", targetType: "aml_case", targetId: id, metadata: { user_id: params.userId, alerts: params.alertIds.length } });
      return id;
    });
    return this.caseDetail(caseId);
  }

  async linkAlerts(context: AdminRequestContext, caseId: string, alertIds: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    await withTransaction(this.deps.pool, { actor: adminActor(context) }, async (tx) => {
      for (const alertId of alertIds) {
        await tx.query("INSERT INTO aml.case_alerts (case_id, alert_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [caseId, alertId]);
      }
      await recordAdminAudit(tx, context, { action: "aml.case_alerts_linked", targetType: "aml_case", targetId: caseId, metadata: { alerts: alertIds } });
    });
    return this.caseDetail(caseId);
  }

  async transitionCase(context: AdminRequestContext, caseId: string, target: "investigating" | "closed", note: string): Promise<Readonly<Record<string, unknown>>> {
    await withTransaction(this.deps.pool, { actor: adminActor(context), changeNote: note }, async (tx) => {
      const updated = await tx.query(
        `UPDATE aml.cases
            SET status = $2::aml.case_status,
                assigned_to_admin_id = COALESCE(assigned_to_admin_id, $3),
                closure_note = CASE WHEN $2 = 'closed' THEN $4 ELSE closure_note END
          WHERE id = $1`,
        [caseId, target, context.adminId, note],
      );
      if (updated.rowCount === 0) throw new NotFoundError("Dossier introuvable.");
      await recordAdminAudit(tx, context, { action: target === "closed" ? "aml.case_closed" : "aml.case_investigating", targetType: "aml_case", targetId: caseId, metadata: { note } });
    });
    return this.caseDetail(caseId);
  }
}
