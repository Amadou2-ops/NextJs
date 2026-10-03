import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Queryable, TransactionClient } from "../../db/transaction.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, sqlStateOf } from "../../lib/errors.js";
import { Money, parseCurrencyCode } from "../../lib/money.js";
import type { MoneyJson } from "../../lib/money.js";
import { ageOn, KycProviderError, matchDeclaredIdentity, normalizeDocumentNumber } from "./providers/types.js";
import type {
  DeclaredIdentity,
  ExtractedIdentity,
  KycChannel,
  KycJobType,
  KycProvider,
  KycProviderName,
  OutcomeSummary,
  ProviderOutcome,
  SdkLaunch,
} from "./providers/types.js";

/**
 * Vérification d'identité (KYC).
 *
 * Niveaux : tier_1 = pièce d'identité + selfie de vivacité ; tier_2 = preuve
 * de domicile (exige tier_1) ; tier_3 = vigilance renforcée, décidée
 * manuellement par la conformité (jamais en libre-service).
 *
 * Décision : le résultat du prestataire n'est jamais appliqué tel quel.
 * Une approbation n'est retenue que si l'identité lue sur la pièce concorde
 * avec l'identité déclarée, si le client est majeur et si la pièce n'est pas
 * déjà rattachée à un autre client ; sinon la vérification part en revue
 * manuelle (in_review) et la conformité est alertée (outbox). La base
 * revérifie ces conditions (migration 0020) et accorde elle-même le niveau.
 */

export type KycTier = "tier_0" | "tier_1" | "tier_2" | "tier_3";
export type VerificationStatus =
  | "created"
  | "pending_submission"
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected"
  | "resubmission_required"
  | "expired";

const ACTIVE_STATUSES: ReadonlySet<VerificationStatus> = new Set(["created", "pending_submission", "submitted", "in_review", "resubmission_required"]);
const TERMINAL_STATUSES: ReadonlySet<VerificationStatus> = new Set(["approved", "rejected", "expired"]);
const MINIMUM_AGE = 18;

export type NextAction = "complete_capture" | "wait" | "retry" | "contact_support" | null;

export interface VerificationView {
  readonly id: string;
  readonly tier: KycTier;
  readonly provider: KycProviderName;
  readonly jobType: KycJobType;
  readonly status: VerificationStatus;
  readonly nextAction: NextAction;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly expiresAt: string | null;
}

export interface KycOverview {
  readonly tier: KycTier;
  readonly limits: {
    readonly singleTransferMax: MoneyJson;
    readonly dailyMax: MoneyJson;
    readonly monthlyMax: MoneyJson;
    readonly annualMax: MoneyJson;
  };
  readonly nextTier: "tier_1" | "tier_2" | null;
  readonly declaredIdentity: boolean;
  readonly attemptsRemaining: number;
  readonly activeVerification: VerificationView | null;
  readonly verifications: readonly VerificationView[];
}

export interface StartVerificationRequest {
  readonly tier: "tier_1" | "tier_2";
  readonly declaredIdentity?: DeclaredIdentity | undefined;
}

export interface StartedVerification {
  readonly verification: VerificationView;
  readonly launch: SdkLaunch;
}

export interface KycServiceOptions {
  readonly verificationValidityDays: number;
  readonly sessionTtlHours: number;
  readonly maxAttemptsPer30Days: number;
}

export type RefreshResult = "updated" | "unchanged" | "ignored";

interface VerificationRow {
  id: string;
  user_id: string;
  provider: KycProviderName;
  job_type: KycJobType;
  tier_requested: KycTier;
  status: VerificationStatus;
  provider_reference: string | null;
  provider_result: Record<string, unknown>;
  created_at: Date;
  submitted_at: Date | null;
  decided_at: Date | null;
  expires_at: Date | null;
}

interface UserRow {
  id: string;
  status: string;
  kyc_tier: KycTier;
  country_of_residence: string;
  country_alpha3: string;
  first_name_enc: Buffer | null;
  last_name_enc: Buffer | null;
  date_of_birth_enc: Buffer | null;
}

const VERIFICATION_COLUMNS = `id, user_id, provider, job_type, tier_requested, status, provider_reference, provider_result,
                              created_at, submitted_at, decided_at, expires_at`;

export class KycService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly logger: Logger;
      readonly providers: ReadonlyMap<KycProviderName, KycProvider>;
      readonly encryptor: FieldEncryptor;
      readonly indexer: BlindIndexer;
      readonly piiKeyId: string;
      readonly options: KycServiceOptions;
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Client
  // ---------------------------------------------------------------------------

  async overview(userId: string): Promise<KycOverview> {
    const user = await this.loadUser(this.deps.pool, userId);
    const limits = await this.deps.pool.query<{ single_transfer_max: bigint; daily_max: bigint; monthly_max: bigint; annual_max: bigint }>(
      "SELECT single_transfer_max, daily_max, monthly_max, annual_max FROM kyc.tier_limits WHERE tier = $1::kyc.kyc_tier",
      [user.kyc_tier],
    );
    const limit = limits.rows[0];
    if (limit === undefined) throw new Error(`plafonds absents pour ${user.kyc_tier}`);
    const verifications = await this.deps.pool.query<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM kyc.verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [userId],
    );
    const nextTier = nextSelfServiceTier(user.kyc_tier);
    const attemptsRemaining = nextTier === null ? 0 : await this.attemptsRemaining(this.deps.pool, userId, nextTier);
    const views = verifications.rows.map((row) => this.view(row, attemptsRemaining));
    const usd = (amount: bigint): MoneyJson => Money.ofMinor(amount, parseCurrencyCode("USD")).toJSON();
    return {
      tier: user.kyc_tier,
      limits: {
        singleTransferMax: usd(limit.single_transfer_max),
        dailyMax: usd(limit.daily_max),
        monthlyMax: usd(limit.monthly_max),
        annualMax: usd(limit.annual_max),
      },
      nextTier,
      declaredIdentity: user.first_name_enc !== null && user.last_name_enc !== null && user.date_of_birth_enc !== null,
      attemptsRemaining,
      activeVerification: views.find((view) => ACTIVE_STATUSES.has(view.status)) ?? null,
      verifications: views,
    };
  }

  async getVerification(userId: string, verificationId: string): Promise<VerificationView> {
    const result = await this.deps.pool.query<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM kyc.verifications WHERE id = $1 AND user_id = $2`,
      [verificationId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Vérification introuvable.");
    const attempts = await this.attemptsRemaining(this.deps.pool, userId, row.tier_requested);
    return this.view(row, attempts);
  }

  async start(userId: string, channel: KycChannel, request: StartVerificationRequest): Promise<StartedVerification> {
    const user = await this.loadUser(this.deps.pool, userId);
    if (user.status !== "active") throw new ForbiddenError("Votre compte doit être actif pour vérifier votre identité.");

    const expected = nextSelfServiceTier(user.kyc_tier);
    if (expected === null || request.tier !== expected) {
      throw new AppError("CONFLICT", 409, "Niveau indisponible", {
        detail:
          expected === null
            ? "Aucune vérification supplémentaire n'est disponible en libre-service pour votre compte."
            : `La prochaine vérification disponible est le niveau ${expected}.`,
      });
    }

    const declared = await this.resolveDeclaredIdentity(user, request.declaredIdentity);
    const route = await this.selectRoute(user.country_of_residence, request.tier);

    // Création (statut created) : la base garantit l'unicité de la vérification en cours.
    const created = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (client) => {
      await this.expireAbandonedSession(client, userId);
      const remaining = await this.attemptsRemaining(client, userId, request.tier);
      if (remaining <= 0) {
        throw new AppError("RATE_LIMITED", 429, "Trop de tentatives", {
          detail: "Le nombre de tentatives de vérification sur 30 jours est atteint. Contactez le support.",
          retryAfterSeconds: 86_400,
        });
      }
      if (request.declaredIdentity !== undefined) await this.storeDeclaredIdentity(client, userId, declared);
      try {
        const inserted = await client.query<VerificationRow>(
          `INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested)
           VALUES ($1, $2::kyc.provider, $3::kyc.job_type, $4::kyc.kyc_tier)
           RETURNING ${VERIFICATION_COLUMNS}`,
          [userId, route.provider.name, route.jobType, request.tier],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error("création de la vérification impossible");
        return row;
      } catch (error: unknown) {
        if (sqlStateOf(error) === "23505") {
          throw new ConflictError("CONFLICT", "Une vérification est déjà en cours. Attendez son résultat.");
        }
        throw error;
      }
    });

    const applicant = await this.deps.pool.query<{ applicant_reference: string }>(
      "SELECT applicant_reference FROM kyc.provider_applicants WHERE user_id = $1 AND provider = $2::kyc.provider",
      [userId, route.provider.name],
    );

    let session;
    try {
      session = await route.provider.startSession({
        verificationId: created.id,
        userId,
        jobType: route.jobType,
        channel,
        declared,
        countryOfResidenceAlpha3: user.country_alpha3,
        existingApplicantReference: applicant.rows[0]?.applicant_reference ?? null,
      });
    } catch (error: unknown) {
      await this.closeFailedSession(created.id, route.provider.name, error);
      this.deps.logger.error({ err: error, verificationId: created.id, provider: route.provider.name }, "ouverture de session KYC impossible");
      throw new ServiceUnavailableError("La vérification d'identité est momentanément indisponible. Réessayez dans quelques minutes.", error, 60);
    }

    const updated = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (client) => {
      if (session.applicantReference !== null) {
        await client.query(
          `INSERT INTO kyc.provider_applicants (user_id, provider, applicant_reference)
           VALUES ($1, $2::kyc.provider, $3)
           ON CONFLICT (user_id, provider) DO NOTHING`,
          [userId, route.provider.name, session.applicantReference],
        );
        const stored = await client.query<{ applicant_reference: string }>(
          "SELECT applicant_reference FROM kyc.provider_applicants WHERE user_id = $1 AND provider = $2::kyc.provider",
          [userId, route.provider.name],
        );
        if (stored.rows[0]?.applicant_reference !== session.applicantReference) {
          throw new Error("dossier prestataire incohérent pour ce client");
        }
      }
      const result = await client.query<VerificationRow>(
        `UPDATE kyc.verifications
            SET status = 'pending_submission', provider_reference = $2,
                provider_result = jsonb_build_object('status', 'session_opened', 'channel', $3::text)
          WHERE id = $1 AND status = 'created'
          RETURNING ${VERIFICATION_COLUMNS}`,
        [created.id, session.providerReference, channel],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("vérification modifiée pendant l'ouverture de session");
      return row;
    });
    const remaining = await this.attemptsRemaining(this.deps.pool, userId, request.tier);
    return { verification: this.view(updated, remaining), launch: session.launch };
  }

  /** Le client signale la fin de la capture dans le SDK (indicatif : la décision vient du prestataire). */
  async markSubmitted(userId: string, verificationId: string): Promise<VerificationView> {
    const row = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (client) => {
      const current = await this.lockVerification(client, verificationId);
      if (current?.user_id !== userId) throw new NotFoundError("Vérification introuvable.");
      if (current.status === "pending_submission") {
        const updated = await client.query<VerificationRow>(
          `UPDATE kyc.verifications SET status = 'submitted', submitted_at = now()
            WHERE id = $1 RETURNING ${VERIFICATION_COLUMNS}`,
          [verificationId],
        );
        return updated.rows[0] ?? current;
      }
      if (current.status === "submitted" || current.status === "in_review" || TERMINAL_STATUSES.has(current.status)) return current;
      throw new ConflictError("CONFLICT", "Cette vérification n'attend pas de soumission.");
    });
    return this.view(row, await this.attemptsRemaining(this.deps.pool, userId, row.tier_requested));
  }

  // ---------------------------------------------------------------------------
  // Prestataires (webhooks, synchronisation)
  // ---------------------------------------------------------------------------

  async findByProviderReference(provider: KycProviderName, reference: string): Promise<{ readonly id: string; readonly userId: string } | null> {
    const result = await this.deps.pool.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM kyc.verifications WHERE provider = $1::kyc.provider AND provider_reference = $2",
      [provider, reference],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, userId: row.user_id };
  }

  /**
   * Relit le résultat chez le prestataire et l'applique. Idempotent : une
   * vérification terminée n'est plus modifiée.
   */
  async refresh(verificationId: string): Promise<RefreshResult> {
    const snapshot = await this.deps.pool.query<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM kyc.verifications WHERE id = $1`,
      [verificationId],
    );
    const current = snapshot.rows[0];
    if (current === undefined) throw new NotFoundError("Vérification introuvable.");
    if (TERMINAL_STATUSES.has(current.status) || current.provider_reference === null) return "ignored";
    if (current.status === "in_review" && current.provider_result["review"] === "internal") return "ignored";

    const provider = this.deps.providers.get(current.provider);
    if (provider === undefined) throw new KycProviderError(current.provider, "prestataire non configuré", false);
    const outcome = await provider.fetchOutcome({
      verificationId: current.id,
      userId: current.user_id,
      providerReference: current.provider_reference,
      jobType: current.job_type,
    });

    // Préparation hors transaction (déchiffrement, chiffrement, index aveugle).
    const prepared = "identity" in outcome && outcome.identity !== null ? await this.prepareEvidence(current, outcome.identity) : null;

    return withTransaction(this.deps.pool, { actor: { type: "provider", id: current.provider } }, async (client) => {
      const locked = await this.lockVerification(client, verificationId);
      if (locked === null || TERMINAL_STATUSES.has(locked.status)) return "ignored";
      if (locked.status === "in_review" && locked.provider_result["review"] === "internal") return "ignored";
      return this.applyOutcome(client, locked, outcome, prepared);
    });
  }

  /**
   * Tâche périodique : relit les vérifications ouvertes chez le prestataire
   * (webhook perdu) et clôt les sessions abandonnées et les approbations
   * échues (le niveau du client est alors recalculé par la base).
   */
  async synchronize(limit: number): Promise<{ readonly refreshed: number; readonly failed: number; readonly expired: number }> {
    const due = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM kyc.verifications
        WHERE provider_reference IS NOT NULL
          AND (status IN ('pending_submission', 'submitted')
               OR (status = 'in_review' AND provider_result->>'review' = 'provider'))
          AND updated_at < now() - interval '5 minutes'
        ORDER BY updated_at
        LIMIT $1`,
      [limit],
    );
    let refreshed = 0;
    let failed = 0;
    for (const { id } of due.rows) {
      try {
        await this.refresh(id);
        refreshed += 1;
      } catch (error: unknown) {
        failed += 1;
        this.deps.logger.warn({ err: error, verificationId: id }, "synchronisation KYC en échec");
      }
    }
    const expired = await withTransaction(this.deps.pool, { actor: { type: "system", id: "kyc-sync" } }, async (client) => {
      const sessions = await client.query(
        `UPDATE kyc.verifications SET status = 'expired',
                provider_result = provider_result || jsonb_build_object('status', 'session_expired')
          WHERE status IN ('created', 'pending_submission')
            AND created_at < now() - make_interval(hours => $1)`,
        [this.deps.options.sessionTtlHours],
      );
      const approvals = await client.query(
        "UPDATE kyc.verifications SET status = 'expired' WHERE status = 'approved' AND expires_at <= now()",
      );
      return (sessions.rowCount ?? 0) + (approvals.rowCount ?? 0);
    });
    return { refreshed, failed, expired };
  }

  // ---------------------------------------------------------------------------
  // Application d'un résultat
  // ---------------------------------------------------------------------------

  private async applyOutcome(
    client: TransactionClient,
    verification: VerificationRow,
    outcome: ProviderOutcome,
    evidence: PreparedEvidence | null,
  ): Promise<RefreshResult> {
    switch (outcome.kind) {
      case "pending": {
        const sessionExpired = verification.created_at.getTime() < this.now().getTime() - this.deps.options.sessionTtlHours * 3_600_000;
        if (verification.status === "pending_submission" && outcome.summary.providerStatus === "processing") {
          await this.setStatus(client, verification.id, "submitted", outcome.summary, null);
          return "updated";
        }
        if ((verification.status === "pending_submission" || verification.status === "created") && sessionExpired) {
          await this.setStatus(client, verification.id, "expired", outcome.summary, null);
          return "updated";
        }
        await this.recordCheck(client, verification.id, outcome.summary);
        return "unchanged";
      }
      case "abandoned": {
        if (verification.status === "pending_submission" || verification.status === "created") {
          await this.setStatus(client, verification.id, "expired", outcome.summary, null);
        } else {
          // Le client avait signalé une soumission : situation à examiner.
          await this.sendToInternalReview(client, verification, outcome.summary, ["provider_abandoned_after_submission"]);
        }
        return "updated";
      }
      case "provider_review": {
        await this.ensureSubmitted(client, verification);
        if (verification.status !== "in_review") await this.setStatus(client, verification.id, "in_review", outcome.summary, "provider");
        else await this.recordCheck(client, verification.id, outcome.summary);
        return "updated";
      }
      case "rejected": {
        await this.ensureSubmitted(client, verification);
        await this.insertEvidence(client, verification, evidence);
        await this.decide(client, verification, "rejected", outcome.summary, outcome.summary.reasons.length > 0 ? outcome.summary.reasons : ["provider_declined"]);
        return "updated";
      }
      case "manual_review": {
        await this.ensureSubmitted(client, verification);
        await this.insertEvidence(client, verification, evidence);
        await this.sendToInternalReview(client, verification, outcome.summary, ["provider_requested_review", ...outcome.summary.reasons]);
        return "updated";
      }
      case "approved": {
        await this.ensureSubmitted(client, verification);
        await this.insertEvidence(client, verification, evidence);
        const blockers = await this.approvalBlockers(client, verification, evidence);
        if (blockers.length > 0) {
          await this.sendToInternalReview(client, verification, outcome.summary, blockers);
        } else {
          await this.decide(client, verification, "approved", outcome.summary, []);
        }
        return "updated";
      }
    }
  }

  /** Conditions d'une approbation automatique (revérifiées par la base). */
  private async approvalBlockers(client: TransactionClient, verification: VerificationRow, evidence: PreparedEvidence | null): Promise<string[]> {
    if (evidence === null) return ["identity_not_extracted"];
    const blockers: string[] = [];
    if (evidence.match.match !== true) blockers.push(evidence.match.reason);
    if (evidence.age !== null && evidence.age < MINIMUM_AGE) blockers.push("underage");
    if (evidence.documentNumberBidx !== null) {
      const duplicate = await client.query(
        `SELECT 1
           FROM kyc.identity_evidence e
           JOIN kyc.verifications v ON v.id = e.verification_id
          WHERE e.document_number_bidx = $1 AND e.user_id <> $2 AND v.status IN ('approved', 'expired')
          LIMIT 1`,
        [evidence.documentNumberBidx, verification.user_id],
      );
      if (duplicate.rows.length > 0) blockers.push("document_already_used");
    }
    return blockers;
  }

  private async ensureSubmitted(client: TransactionClient, verification: VerificationRow): Promise<void> {
    if (verification.status === "created" || verification.status === "pending_submission" || verification.status === "resubmission_required") {
      await client.query(
        `UPDATE kyc.verifications SET status = 'submitted', submitted_at = COALESCE(submitted_at, now()) WHERE id = $1`,
        [verification.id],
      );
    }
  }

  private async decide(
    client: TransactionClient,
    verification: VerificationRow,
    status: "approved" | "rejected",
    summary: OutcomeSummary,
    reasons: readonly string[],
  ): Promise<void> {
    await client.query(
      `UPDATE kyc.verifications
          SET status = $2::kyc.verification_status,
              decided_at = now(),
              expires_at = CASE WHEN $2 = 'approved' THEN now() + make_interval(days => $3) ELSE NULL END,
              rejection_reasons = $4::text[],
              provider_result = $5::jsonb
        WHERE id = $1`,
      [verification.id, status, this.deps.options.verificationValidityDays, reasons, JSON.stringify(resultDocument(summary, null))],
    );
    await this.emit(client, verification, status === "approved" ? "kyc.verification_approved" : "kyc.verification_rejected", { reasons });
  }

  private async sendToInternalReview(client: TransactionClient, verification: VerificationRow, summary: OutcomeSummary, reasons: readonly string[]): Promise<void> {
    await this.ensureSubmitted(client, verification);
    await client.query(
      `UPDATE kyc.verifications
          SET status = 'in_review', rejection_reasons = $2::text[], provider_result = $3::jsonb
        WHERE id = $1`,
      [verification.id, reasons, JSON.stringify(resultDocument(summary, "internal"))],
    );
    await this.emit(client, verification, "kyc.review_required", { reasons });
  }

  private async setStatus(
    client: TransactionClient,
    verificationId: string,
    status: "submitted" | "in_review" | "expired",
    summary: OutcomeSummary,
    review: "provider" | "internal" | null,
  ): Promise<void> {
    await client.query(
      `UPDATE kyc.verifications
          SET status = $2::kyc.verification_status,
              submitted_at = CASE WHEN $2 = 'submitted' THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
              provider_result = $3::jsonb
        WHERE id = $1`,
      [verificationId, status, JSON.stringify(resultDocument(summary, review))],
    );
  }

  private async recordCheck(client: TransactionClient, verificationId: string, summary: OutcomeSummary): Promise<void> {
    await client.query(
      `UPDATE kyc.verifications SET provider_result = provider_result || $2::jsonb WHERE id = $1`,
      [verificationId, JSON.stringify({ status: summary.providerStatus, checked_at: this.now().toISOString() })],
    );
  }

  private async emit(client: TransactionClient, verification: VerificationRow, eventType: string, extra: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
       VALUES ('kyc_verification', $1, $2, $3::jsonb, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        verification.id,
        eventType,
        JSON.stringify({ verification_id: verification.id, user_id: verification.user_id, tier: verification.tier_requested, provider: verification.provider, ...extra }),
        `${eventType}:${verification.id}`,
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Preuve d'identité
  // ---------------------------------------------------------------------------

  private async prepareEvidence(verification: VerificationRow, identity: ExtractedIdentity): Promise<PreparedEvidence> {
    const user = await this.loadUser(this.deps.pool, verification.user_id);
    const declared = await this.decryptDeclared(user);
    const requireDateOfBirth = verification.job_type !== "proof_of_address";
    const match: PreparedEvidence["match"] =
      declared === null ? { match: null, reason: "declared_identity_missing" } : matchDeclaredIdentity(declared, identity, requireDateOfBirth);
    const birth = identity.dateOfBirth ?? declared?.dateOfBirth ?? null;

    const issuingCountry = identity.issuingCountry === null ? null : await this.resolveCountry(identity.issuingCountry);
    const normalizedNumber = identity.documentNumber === null ? null : normalizeDocumentNumber(identity.documentNumber);
    const context = (column: string): string => fieldContext("kyc", "identity_evidence", column, verification.id);
    const withNumber = normalizedNumber !== null && issuingCountry !== null;

    return {
      documentType: identity.documentType,
      issuingCountry,
      documentNumberEnc: withNumber ? await this.deps.encryptor.encrypt(normalizedNumber, context("document_number")) : null,
      documentNumberBidx: withNumber ? this.deps.indexer.compute("document_number", `${issuingCountry}:${normalizedNumber}`) : null,
      fullNameEnc: identity.fullName === null ? null : await this.deps.encryptor.encrypt(identity.fullName, context("full_name")),
      dateOfBirthEnc: identity.dateOfBirth === null ? null : await this.deps.encryptor.encrypt(identity.dateOfBirth, context("date_of_birth")),
      match,
      age: birth === null ? null : ageOn(birth, this.now()),
    };
  }

  private async insertEvidence(client: TransactionClient, verification: VerificationRow, evidence: PreparedEvidence | null): Promise<void> {
    if (evidence === null) return;
    await client.query(
      `INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, document_type, issuing_country,
                                          document_number_enc, document_number_bidx, full_name_enc, date_of_birth_enc,
                                          pii_key_id, declared_identity_match)
       VALUES ($1, $2, $3::kyc.provider, $4::kyc.document_type, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (verification_id) DO NOTHING`,
      [
        verification.id,
        verification.user_id,
        verification.provider,
        evidence.documentType,
        evidence.issuingCountry,
        evidence.documentNumberEnc,
        evidence.documentNumberBidx,
        evidence.fullNameEnc,
        evidence.dateOfBirthEnc,
        this.deps.piiKeyId,
        evidence.match.match,
      ],
    );
  }

  private async resolveCountry(code: string): Promise<string | null> {
    const result = await this.deps.pool.query<{ alpha2: string }>(
      "SELECT alpha2 FROM ref.countries WHERE alpha2 = $1 OR alpha3 = $1",
      [code.toUpperCase()],
    );
    return result.rows[0]?.alpha2 ?? null;
  }

  // ---------------------------------------------------------------------------
  // Identité déclarée
  // ---------------------------------------------------------------------------

  private async resolveDeclaredIdentity(user: UserRow, provided: DeclaredIdentity | undefined): Promise<DeclaredIdentity> {
    const stored = await this.decryptDeclared(user);
    if (provided !== undefined) {
      if (user.kyc_tier !== "tier_0") {
        throw new AppError("CONFLICT", 409, "Identité figée", {
          detail: "Votre identité a déjà été vérifiée et ne peut plus être modifiée ici. Contactez le support.",
        });
      }
      if (ageOn(provided.dateOfBirth, this.now()) < MINIMUM_AGE) {
        throw new AppError("VALIDATION_FAILED", 422, "Âge minimal non atteint", {
          detail: `Le service est réservé aux personnes majeures (${MINIMUM_AGE} ans révolus).`,
        });
      }
      return provided;
    }
    if (stored === null) {
      throw new AppError("VALIDATION_FAILED", 422, "Identité requise", {
        detail: "Indiquez vos prénom, nom et date de naissance tels qu'ils figurent sur votre pièce d'identité.",
      });
    }
    return stored;
  }

  private async storeDeclaredIdentity(client: TransactionClient, userId: string, declared: DeclaredIdentity): Promise<void> {
    const context = (column: string): string => fieldContext("identity", "users", column, userId);
    await client.query(
      `UPDATE identity.users SET first_name_enc = $2, last_name_enc = $3, date_of_birth_enc = $4 WHERE id = $1`,
      [
        userId,
        await this.deps.encryptor.encrypt(declared.firstName, context("first_name")),
        await this.deps.encryptor.encrypt(declared.lastName, context("last_name")),
        await this.deps.encryptor.encrypt(declared.dateOfBirth, context("date_of_birth")),
      ],
    );
  }

  private async decryptDeclared(user: UserRow): Promise<DeclaredIdentity | null> {
    if (user.first_name_enc === null || user.last_name_enc === null || user.date_of_birth_enc === null) return null;
    const context = (column: string): string => fieldContext("identity", "users", column, user.id);
    return {
      firstName: await this.deps.encryptor.decrypt(user.first_name_enc, context("first_name")),
      lastName: await this.deps.encryptor.decrypt(user.last_name_enc, context("last_name")),
      dateOfBirth: await this.deps.encryptor.decrypt(user.date_of_birth_enc, context("date_of_birth")),
    };
  }

  // ---------------------------------------------------------------------------
  // Divers
  // ---------------------------------------------------------------------------

  private async selectRoute(country: string, tier: "tier_1" | "tier_2"): Promise<{ readonly provider: KycProvider; readonly jobType: KycJobType }> {
    const routes = await this.deps.pool.query<{ provider: KycProviderName; job_type: KycJobType }>(
      `SELECT provider, job_type
         FROM kyc.provider_routes
        WHERE is_enabled AND tier = $1::kyc.kyc_tier AND (country_of_residence = $2 OR country_of_residence IS NULL)
        ORDER BY country_of_residence IS NULL, priority, created_at`,
      [tier, country],
    );
    for (const route of routes.rows) {
      const provider = this.deps.providers.get(route.provider);
      if (provider?.supports(route.job_type) === true) return { provider, jobType: route.job_type };
    }
    throw new ServiceUnavailableError("La vérification d'identité n'est pas disponible pour votre pays de résidence pour le moment.", undefined, 3600);
  }

  /** Une session jamais terminée par le client peut être remplacée par une nouvelle. */
  private async expireAbandonedSession(client: TransactionClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE kyc.verifications
          SET status = 'expired', provider_result = provider_result || jsonb_build_object('status', 'replaced_by_new_session')
        WHERE user_id = $1 AND status IN ('created', 'pending_submission')`,
      [userId],
    );
  }

  private async closeFailedSession(verificationId: string, provider: KycProviderName, error: unknown): Promise<void> {
    try {
      await withTransaction(this.deps.pool, { actor: { type: "system", id: "kyc-session" } }, async (client) => {
        await client.query(
          `UPDATE kyc.verifications
              SET status = 'expired',
                  provider_result = jsonb_build_object('status', 'session_failed', 'retryable', $2::boolean)
            WHERE id = $1 AND status = 'created'`,
          [verificationId, error instanceof KycProviderError ? error.retryable : true],
        );
      });
    } catch (closeError: unknown) {
      this.deps.logger.error({ err: closeError, verificationId, provider }, "impossible de clore la session KYC en échec");
    }
  }

  private async attemptsRemaining(db: Queryable, userId: string, tier: KycTier): Promise<number> {
    // Une session remplacée ou en échec technique ne compte pas comme une tentative.
    const result = await db.query<{ attempts: string }>(
      `SELECT count(*)::text AS attempts
         FROM kyc.verifications
        WHERE user_id = $1 AND tier_requested = $2::kyc.kyc_tier
          AND created_at > now() - interval '30 days'
          AND COALESCE(provider_result->>'status', '') NOT IN ('replaced_by_new_session', 'session_failed', 'session_expired')`,
      [userId, tier],
    );
    return Math.max(0, this.deps.options.maxAttemptsPer30Days - Number(result.rows[0]?.attempts ?? "0"));
  }

  private async loadUser(db: Queryable, userId: string): Promise<UserRow> {
    const result = await db.query<UserRow>(
      `SELECT u.id, u.status::text AS status, u.kyc_tier, u.country_of_residence, c.alpha3 AS country_alpha3,
              u.first_name_enc, u.last_name_enc, u.date_of_birth_enc
         FROM identity.users u
         JOIN ref.countries c ON c.alpha2 = u.country_of_residence
        WHERE u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Client introuvable.");
    return row;
  }

  private async lockVerification(client: TransactionClient, verificationId: string): Promise<VerificationRow | null> {
    const result = await client.query<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM kyc.verifications WHERE id = $1 FOR UPDATE`,
      [verificationId],
    );
    return result.rows[0] ?? null;
  }

  private view(row: VerificationRow, attemptsRemaining: number): VerificationView {
    return {
      id: row.id,
      tier: row.tier_requested,
      provider: row.provider,
      jobType: row.job_type,
      status: row.status,
      nextAction: nextAction(row.status, attemptsRemaining),
      createdAt: row.created_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      decidedAt: row.decided_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
    };
  }
}

interface PreparedEvidence {
  readonly documentType: ExtractedIdentity["documentType"];
  readonly issuingCountry: string | null;
  readonly documentNumberEnc: Buffer | null;
  readonly documentNumberBidx: Buffer | null;
  readonly fullNameEnc: Buffer | null;
  readonly dateOfBirthEnc: Buffer | null;
  readonly match: { readonly match: true } | { readonly match: false | null; readonly reason: string };
  readonly age: number | null;
}

function resultDocument(summary: OutcomeSummary, review: "provider" | "internal" | null): Record<string, unknown> {
  return {
    status: summary.providerStatus,
    result_code: summary.resultCode,
    result_text: summary.resultText,
    reasons: summary.reasons,
    review,
  };
}

export function nextSelfServiceTier(current: KycTier): "tier_1" | "tier_2" | null {
  if (current === "tier_0") return "tier_1";
  if (current === "tier_1") return "tier_2";
  return null;
}

function nextAction(status: VerificationStatus, attemptsRemaining: number): NextAction {
  switch (status) {
    case "created":
    case "pending_submission":
      return "complete_capture";
    case "submitted":
    case "in_review":
      return "wait";
    case "resubmission_required":
    case "expired":
      return attemptsRemaining > 0 ? "retry" : "contact_support";
    case "rejected":
      return attemptsRemaining > 0 ? "retry" : "contact_support";
    case "approved":
      return null;
  }
}

