import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Queryable } from "../../db/transaction.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import { AppError, ConflictError } from "../../lib/errors.js";
import { recordAudit } from "./auth.repository.js";
import type { RequestContext } from "./auth.service.js";
import { base32Encode, generateTotpSecret, totpProvisioningUri, verifyTotp } from "./totp.js";

/**
 * Double authentification par application (TOTP). Le secret est chiffré
 * (enveloppe AES-256-GCM liée à l'utilisateur) ; il n'est actif qu'après
 * confirmation d'un premier code. Chaque pas de temps n'est accepté qu'une fois.
 */

const TOTP_ISSUER = "TransfertPlus";

interface TotpRow {
  mfa_totp_secret_enc: Buffer | null;
  mfa_totp_enabled_at: Date | null;
  mfa_totp_last_used_step: string | bigint | null;
  customer_number: string | bigint;
}

function invalidTotp(): AppError {
  return new AppError("INVALID_VERIFICATION_CODE", 422, "Code incorrect", { detail: "Le code de l'application d'authentification est incorrect." });
}

export class MfaService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly encryptor: FieldEncryptor,
  ) {}

  private context(userId: string): string {
    return fieldContext("identity", "users", "mfa_totp_secret", userId);
  }

  private async loadForUpdate(db: Queryable, userId: string): Promise<TotpRow> {
    const result = await db.query<TotpRow>(
      `SELECT mfa_totp_secret_enc, mfa_totp_enabled_at, mfa_totp_last_used_step, customer_number
         FROM identity.users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("utilisateur introuvable");
    return row;
  }

  /**
   * Vérifie un code TOTP d'un utilisateur dont la double authentification est
   * active et enregistre son pas de temps (anti-rejeu). Faux si invalide.
   */
  async verifyAndConsumeTotp(db: Queryable, userId: string, code: string): Promise<boolean> {
    const row = await this.loadForUpdate(db, userId);
    if (row.mfa_totp_enabled_at === null || row.mfa_totp_secret_enc === null) return false;
    const secret = Buffer.from(await this.encryptor.decrypt(row.mfa_totp_secret_enc, this.context(userId)), "base64");
    const step = verifyTotp(secret, code, { lastUsedStep: row.mfa_totp_last_used_step === null ? null : Number(row.mfa_totp_last_used_step) });
    secret.fill(0);
    if (step === undefined) return false;
    await db.query("UPDATE identity.users SET mfa_totp_last_used_step = $2 WHERE id = $1", [userId, step]);
    return true;
  }

  async startEnrollment(userId: string): Promise<{ readonly secret: string; readonly otpauthUri: string }> {
    return withTransaction(this.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      const row = await this.loadForUpdate(tx, userId);
      if (row.mfa_totp_enabled_at !== null) throw new ConflictError("CONFLICT", "La double authentification est déjà activée.");
      const secret = generateTotpSecret();
      const encrypted = await this.encryptor.encrypt(secret.toString("base64"), this.context(userId));
      await tx.query("UPDATE identity.users SET mfa_totp_secret_enc = $2, mfa_totp_last_used_step = NULL WHERE id = $1", [userId, encrypted]);
      const result = {
        secret: base32Encode(secret),
        otpauthUri: totpProvisioningUri({ secret, issuer: TOTP_ISSUER, accountLabel: `Client ${String(row.customer_number)}` }),
      };
      secret.fill(0);
      return result;
    });
  }

  async confirmEnrollment(userId: string, code: string, context: RequestContext): Promise<void> {
    const confirmed = await withTransaction(this.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      const row = await this.loadForUpdate(tx, userId);
      if (row.mfa_totp_enabled_at !== null) return "already_enabled" as const;
      if (row.mfa_totp_secret_enc === null) return "not_started" as const;
      const secret = Buffer.from(await this.encryptor.decrypt(row.mfa_totp_secret_enc, this.context(userId)), "base64");
      const step = verifyTotp(secret, code);
      secret.fill(0);
      if (step === undefined) return "invalid" as const;
      await tx.query(
        "UPDATE identity.users SET mfa_totp_enabled_at = now(), mfa_totp_last_used_step = $2 WHERE id = $1",
        [userId, step],
      );
      await recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.totp_enabled",
        targetType: "user",
        targetId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return "enabled" as const;
    });
    if (confirmed === "already_enabled") throw new ConflictError("CONFLICT", "La double authentification est déjà activée.");
    if (confirmed === "not_started") throw new ConflictError("CONFLICT", "Aucune activation en cours : recommencez la configuration.");
    if (confirmed === "invalid") throw invalidTotp();
  }

  async disable(userId: string, code: string, context: RequestContext): Promise<void> {
    const outcome = await withTransaction(this.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      if (!(await this.verifyAndConsumeTotp(tx, userId, code))) return false;
      await tx.query(
        "UPDATE identity.users SET mfa_totp_enabled_at = NULL, mfa_totp_secret_enc = NULL, mfa_totp_last_used_step = NULL WHERE id = $1",
        [userId],
      );
      await recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.totp_disabled",
        targetType: "user",
        targetId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return true;
    });
    if (!outcome) throw invalidTotp();
  }
}
