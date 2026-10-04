import { randomBytes, randomUUID } from "node:crypto";

import type { CountryCode } from "libphonenumber-js/max";
import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Queryable } from "../../db/transaction.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { NormalizationError, normalizePhone } from "../../lib/crypto/blindIndex.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../lib/errors.js";
import { SmsDeliveryError } from "../../lib/sms/smsSender.js";
import * as repository from "./auth.repository.js";
import type { CustomerAudience, RefreshTokenRow } from "./auth.repository.js";
import { AttestationError } from "./attestation/types.js";
import type { AttestationEvidence, AttestationVerifier } from "./attestation/types.js";
import type { DeviceBindingService, SignedRequestParts } from "./deviceBinding.service.js";
import { importDevicePublicKey } from "./deviceBinding.service.js";
import type { MfaService } from "./mfa.service.js";
import type { OtpService } from "./otp.service.js";
import type { PasswordService } from "./password.service.js";
import type { TokenService } from "./token.service.js";
import { hashRefreshToken, isWellFormedRefreshToken } from "./token.service.js";

/**
 * Parcours d'authentification des clients.
 *
 * Inscription : numéro de téléphone → code SMS → mot de passe (+ appareil
 *   attesté sur mobile) → session de niveau 2 (possession du téléphone +
 *   connaissance du mot de passe).
 *
 * Connexion :
 *   - mobile, appareil connu : mot de passe + requête signée par la clé
 *     matérielle de l'appareil → session de niveau 2 immédiate ;
 *   - nouvel appareil mobile ou site web : mot de passe → second facteur
 *     (TOTP s'il est activé, sinon code SMS) → session de niveau 2.
 *
 * Renouvellement : jeton opaque à usage unique ; la réutilisation d'un jeton
 *   déjà consommé révoque toute la session (vol présumé).
 *
 * Anti-énumération : réponses et temps de traitement identiques que le compte
 * existe ou non, jusqu'à ce que l'appelant ait prouvé la possession du numéro.
 */

const DEVICE_CHALLENGE_TTL_SECONDS = 300;
const LOGIN_CHALLENGE_TTL_SECONDS = 300;

export interface RequestContext {
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly requestId: string;
}

export interface DeviceRegistration {
  readonly challengeId: string;
  readonly platform: "ios" | "android";
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
  /** Clé publique SPKI DER, base64. */
  readonly publicKey: string;
  readonly publicKeyAlgorithm: "ES256" | "EdDSA";
  readonly attestation: AttestationEvidence;
}

export type ClientDescriptor =
  | { readonly type: "web" }
  | { readonly type: "mobile"; readonly device: DeviceRegistration }
  | { readonly type: "mobile"; readonly deviceId: string };

export interface AuthenticatedResult {
  readonly status: "authenticated";
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string | null;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface SecondFactorRequired {
  readonly status: "second_factor_required";
  readonly loginChallengeId: string;
  readonly method: "sms_otp" | "totp";
  readonly expiresAt: Date;
}

interface VerifiedDevice {
  readonly challengeId: string;
  readonly insert: Omit<repository.DeviceInsert, "userId">;
}

export interface AuthServiceDependencies {
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly passwords: PasswordService;
  readonly otp: OtpService;
  readonly tokens: TokenService;
  readonly mfa: MfaService;
  readonly deviceBinding: DeviceBindingService;
  readonly attestation: AttestationVerifier;
  readonly indexer: BlindIndexer;
  readonly encryptor: FieldEncryptor;
  readonly piiKeyId: string;
}

function invalidCredentials(): AppError {
  return new AppError("INVALID_CREDENTIALS", 401, "Identifiants invalides", {
    detail: "Numéro de téléphone ou mot de passe incorrect.",
  });
}

function invalidCode(reason: string): AppError {
  if (reason === "expired" || reason === "exhausted" || reason === "not_found") {
    return new AppError("VERIFICATION_EXPIRED", 410, "Vérification expirée", {
      detail: "Ce code n'est plus valable. Demandez-en un nouveau.",
      internalContext: { reason },
    });
  }
  return new AppError("INVALID_VERIFICATION_CODE", 422, "Code incorrect", {
    detail: "Le code saisi est incorrect.",
    internalContext: { reason },
  });
}

function accountLocked(lockedUntil: Date): AppError {
  return new AppError("ACCOUNT_LOCKED", 423, "Compte temporairement verrouillé", {
    detail: "Trop de tentatives. Réessayez plus tard ou réinitialisez votre mot de passe.",
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)),
  });
}

function accountDisabled(status: string): AppError {
  return new AppError("ACCOUNT_DISABLED", 403, "Compte inaccessible", {
    detail: "Ce compte est suspendu ou clôturé. Contactez le service client.",
    internalContext: { reason: `user_${status}` },
  });
}

function totpRequired(): AppError {
  return new AppError("TOTP_REQUIRED", 401, "Code d'authentification requis", {
    detail: "Votre compte est protégé par une application d'authentification : saisissez son code, puis demandez un nouveau code SMS.",
  });
}

function smsFailure(error: unknown): AppError {
  return new ServiceUnavailableError("L'envoi du SMS a échoué. Réessayez dans quelques instants.", error, 30);
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDependencies) {}

  // ---------------------------------------------------------------------------
  // Défis d'attestation d'appareil
  // ---------------------------------------------------------------------------

  async createDeviceChallenge(context: RequestContext): Promise<{ readonly challengeId: string; readonly challenge: string; readonly expiresAt: Date }> {
    const challenge = randomBytes(32);
    const result = await this.deps.pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO identity.device_challenges (challenge, ip_address, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       RETURNING id, expires_at`,
      [challenge, context.ipAddress ?? null, DEVICE_CHALLENGE_TTL_SECONDS],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("création du défi d'appareil impossible");
    return { challengeId: row.id, challenge: challenge.toString("base64url"), expiresAt: row.expires_at };
  }

  /**
   * Vérifie l'attestation d'un nouvel appareil. Le défi n'est consommé que
   * dans la transaction qui enregistre l'appareil (usage unique garanti).
   */
  private async verifyNewDevice(device: DeviceRegistration): Promise<VerifiedDevice> {
    const challenge = await this.deps.pool.query<{ challenge: Buffer }>(
      `SELECT challenge FROM identity.device_challenges
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [device.challengeId],
    );
    const row = challenge.rows[0];
    if (row === undefined) {
      throw new AppError("VERIFICATION_EXPIRED", 410, "Défi d'appareil expiré", { detail: "Demandez un nouveau défi d'appareil." });
    }
    const publicKeySpki = Buffer.from(device.publicKey, "base64");
    importDevicePublicKey(publicKeySpki, device.publicKeyAlgorithm);
    const expectedEvidence = device.platform === "ios" ? "app_attest" : "play_integrity";
    if (device.attestation.type !== expectedEvidence) {
      throw new ValidationError([{ path: "body.client.device.attestation.type", message: `attendu : ${expectedEvidence}` }]);
    }
    try {
      await this.deps.attestation.verify({ challenge: row.challenge, devicePublicKeySpki: publicKeySpki, evidence: device.attestation });
    } catch (error: unknown) {
      if (error instanceof AttestationError) {
        throw new AppError("DEVICE_ATTESTATION_FAILED", 422, "Appareil non vérifié", {
          detail: "L'authenticité de l'application ou de l'appareil n'a pas pu être établie.",
          cause: error,
          internalContext: { reason: error.message, platform: device.platform },
        });
      }
      throw error;
    }
    return {
      challengeId: device.challengeId,
      insert: {
        platform: device.platform,
        name: device.name,
        appVersion: device.appVersion,
        osVersion: device.osVersion,
        publicKeySpki,
        publicKeyAlgorithm: device.publicKeyAlgorithm,
        attestationType: device.attestation.type,
      },
    };
  }

  private async registerVerifiedDevice(db: Queryable, userId: string, device: VerifiedDevice): Promise<string> {
    if (!(await repository.consumeDeviceChallenge(db, device.challengeId))) {
      throw new AppError("VERIFICATION_EXPIRED", 410, "Défi d'appareil expiré", { detail: "Demandez un nouveau défi d'appareil." });
    }
    return repository.insertTrustedDevice(db, { ...device.insert, userId });
  }

  private normalizePhoneOrThrow(phone: string, defaultCountry: string | undefined): { readonly e164: string; readonly country: string } {
    try {
      return normalizePhone(phone, defaultCountry as CountryCode | undefined);
    } catch (error: unknown) {
      if (error instanceof NormalizationError) {
        throw new ValidationError([{ path: "body.phone", message: error.message }]);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Inscription
  // ---------------------------------------------------------------------------

  async startRegistration(
    params: { readonly phone: string; readonly countryHint?: string; readonly locale: string },
    context: RequestContext,
  ): Promise<{ readonly challengeId: string; readonly expiresAt: Date }> {
    const phone = this.normalizePhoneOrThrow(params.phone, params.countryHint);
    const phoneBidx = this.deps.indexer.compute("phone", phone.e164);

    const { otp, alreadyRegistered } = await withTransaction(
      this.deps.pool,
      { actor: { type: "system", id: "auth:registration" } },
      async (tx) => {
        const existing = await repository.findUserByPhoneIndex(tx, phoneBidx);
        const created = await this.deps.otp.create(tx, {
          purpose: "phone_verification",
          phoneE164: phone.e164,
          userId: null,
          ipAddress: context.ipAddress,
        });
        return { otp: created, alreadyRegistered: existing !== undefined };
      },
    );

    try {
      if (alreadyRegistered) {
        // Même réponse qu'un nouveau numéro ; le titulaire réel est prévenu.
        await this.deps.otp.sendExistingAccountNotice(phone.e164, params.locale);
      } else {
        await this.deps.otp.sendCode(phone.e164, otp.code, params.locale);
      }
    } catch (error: unknown) {
      if (error instanceof SmsDeliveryError) throw smsFailure(error);
      throw error;
    }
    return { challengeId: otp.challengeId, expiresAt: otp.expiresAt };
  }

  async completeRegistration(
    params: {
      readonly challengeId: string;
      readonly code: string;
      readonly phone: string;
      readonly password: string;
      readonly countryOfResidence: string;
      readonly preferredLocale: string;
      readonly client: ClientDescriptor;
    },
    context: RequestContext,
  ): Promise<AuthenticatedResult> {
    const phone = this.normalizePhoneOrThrow(params.phone, params.countryOfResidence);
    if (params.client.type === "mobile" && !("device" in params.client)) {
      throw new ValidationError([{ path: "body.client.device", message: "un nouvel appareil doit être enregistré à l'inscription" }]);
    }
    await this.deps.passwords.assertAcceptable(params.password, { phoneE164: phone.e164 });
    const device = params.client.type === "mobile" && "device" in params.client ? await this.verifyNewDevice(params.client.device) : undefined;
    const passwordHash = await this.deps.passwords.hash(params.password);
    const userId = randomUUID();
    const phoneEnc = await this.deps.encryptor.encrypt(phone.e164, fieldContext("identity", "users", "phone", userId));
    const phoneBidx = this.deps.indexer.compute("phone", phone.e164);
    const refresh = this.deps.tokens.generateRefreshToken();
    const audience: CustomerAudience = params.client.type;

    const outcome = await withTransaction(
      this.deps.pool,
      { actor: { type: "customer", id: userId }, changeNote: "inscription" },
      async (tx) => {
        const verification = await this.deps.otp.verify(tx, { challengeId: params.challengeId, code: params.code, purpose: "phone_verification" });
        if (!verification.ok) return { kind: "invalid_code" as const, reason: verification.reason };
        if (!verification.destinationBidx.equals(this.deps.otp.destinationIndex(phone.e164))) {
          return { kind: "invalid_code" as const, reason: "phone_mismatch" };
        }
        if ((await repository.findUserByPhoneIndex(tx, phoneBidx)) !== undefined) {
          return { kind: "already_registered" as const };
        }
        await repository.insertUser(tx, {
          id: userId,
          phoneBidx,
          phoneEnc,
          phoneCountry: phone.country,
          passwordHash,
          countryOfResidence: params.countryOfResidence,
          preferredLocale: params.preferredLocale,
          piiKeyId: this.deps.piiKeyId,
        });
        const deviceId = device === undefined ? null : await this.registerVerifiedDevice(tx, userId, device);
        const session = await repository.createSession(tx, {
          userId,
          deviceId,
          audience,
          assuranceLevel: 2,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          refreshTokenSha256: refresh.sha256,
        });
        await repository.recordSuccessfulLogin(tx, userId);
        await repository.recordAudit(tx, {
          actorType: "customer",
          actorId: userId,
          action: "auth.registered",
          targetType: "user",
          targetId: userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { audience, deviceId, phoneCountry: phone.country },
        });
        return { kind: "created" as const, deviceId, session };
      },
    );

    if (outcome.kind === "invalid_code") throw invalidCode(outcome.reason);
    if (outcome.kind === "already_registered") {
      throw new ConflictError("CONFLICT", "Un compte existe déjà pour ce numéro. Connectez-vous.");
    }
    return this.authenticated({
      userId,
      sessionId: outcome.session.sessionId,
      deviceId: outcome.deviceId,
      audience,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: outcome.session.refreshToken.expiresAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Mot de passe oublié
  //
  // Preuve de possession du numéro (code SMS) et, si le client l'a activée,
  // de l'application d'authentification (une carte SIM détournée ne suffit
  // pas). Réponse identique que le numéro corresponde ou non à un compte
  // actif. Toutes les sessions sont révoquées ; le client est prévenu par SMS
  // (outbox, modèle password_changed).
  // ---------------------------------------------------------------------------

  async startPasswordReset(
    params: { readonly phone: string; readonly countryHint?: string; readonly locale: string },
    context: RequestContext,
  ): Promise<{ readonly challengeId: string; readonly expiresAt: Date }> {
    const phone = this.normalizePhoneOrThrow(params.phone, params.countryHint);
    const user = await repository.findUserByPhoneIndex(this.deps.pool, this.deps.indexer.compute("phone", phone.e164));
    const otp = await withTransaction(this.deps.pool, { actor: { type: "system", id: "auth:password_reset" } }, (tx) =>
      this.deps.otp.create(tx, { purpose: "password_reset", phoneE164: phone.e164, userId: user?.id ?? null, ipAddress: context.ipAddress }),
    );
    if (user?.status === "active") {
      try {
        await this.deps.otp.sendCode(phone.e164, otp.code, user.preferred_locale);
      } catch (error: unknown) {
        // Pas d'erreur visible : elle révélerait l'existence du compte.
        this.deps.logger.error({ err: error, requestId: context.requestId }, "envoi du code de réinitialisation en échec");
      }
    }
    return { challengeId: otp.challengeId, expiresAt: otp.expiresAt };
  }

  async completePasswordReset(
    params: {
      readonly challengeId: string;
      readonly code: string;
      readonly phone: string;
      readonly countryHint?: string;
      readonly password: string;
      readonly totpCode?: string;
    },
    context: RequestContext,
  ): Promise<void> {
    const phone = this.normalizePhoneOrThrow(params.phone, params.countryHint);
    const phoneBidx = this.deps.indexer.compute("phone", phone.e164);
    await this.deps.passwords.assertAcceptable(params.password, { phoneE164: phone.e164 });
    const passwordHash = await this.deps.passwords.hash(params.password);

    // Code SMS consommé même en cas d'échec ultérieur (TOTP faux) : chaque
    // essai du second facteur coûte un nouveau code, limité par numéro.
    const outcome = await withTransaction(this.deps.pool, { actor: { type: "system", id: "auth:password_reset" }, changeNote: "réinitialisation du mot de passe" }, async (tx) => {
      const verification = await this.deps.otp.verify(tx, { challengeId: params.challengeId, code: params.code, purpose: "password_reset" });
      if (!verification.ok) return { kind: "invalid_code" as const, reason: verification.reason };
      if (!verification.destinationBidx.equals(this.deps.otp.destinationIndex(phone.e164))) return { kind: "invalid_code" as const, reason: "phone_mismatch" };
      const user = await repository.findUserByPhoneIndex(tx, phoneBidx);
      if (user?.id === undefined || verification.userId !== user.id) return { kind: "invalid_code" as const, reason: "no_account" };
      if (user.status !== "active") return { kind: "inactive" as const, status: user.status };
      const secondFactor = user.mfa_totp_enabled_at === null ? "sms_otp" : "totp";
      if (secondFactor === "totp" && (params.totpCode === undefined || !(await this.deps.mfa.verifyAndConsumeTotp(tx, user.id, params.totpCode)))) {
        await repository.recordAudit(tx, {
          actorType: "system",
          actorId: null,
          action: "auth.password_reset_failed",
          targetType: "user",
          targetId: user.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { reason: params.totpCode === undefined ? "totp_missing" : "totp_invalid" },
        });
        return { kind: "totp_required" as const };
      }
      await tx.query("UPDATE identity.users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1", [user.id, passwordHash]);
      const revokedSessions = await repository.revokeUserSessions(tx, { userId: user.id, reason: "password_reset" });
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: user.id,
        action: "auth.password_reset",
        targetType: "user",
        targetId: user.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { secondFactor, revokedSessions },
      });
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('user', $1, 'customers.password_reset', $2::jsonb, $3)`,
        [user.id, JSON.stringify({ user_id: user.id, second_factor: secondFactor, revoked_sessions: revokedSessions }), `password-reset:${params.challengeId}`],
      );
      return { kind: "reset" as const };
    });

    if (outcome.kind === "invalid_code") throw invalidCode(outcome.reason);
    if (outcome.kind === "inactive") {
      throw accountDisabled(outcome.status);
    }
    if (outcome.kind === "totp_required") throw totpRequired();
  }

  // ---------------------------------------------------------------------------
  // Connexion
  // ---------------------------------------------------------------------------

  async startLogin(
    params: { readonly phone: string; readonly password: string; readonly client: ClientDescriptor; readonly signedRequest: SignedRequestParts },
    context: RequestContext,
  ): Promise<AuthenticatedResult | SecondFactorRequired> {
    let phone: { readonly e164: string; readonly country: string };
    try {
      phone = normalizePhone(params.phone);
    } catch {
      await this.deps.passwords.verifyAgainstDummy(params.password);
      throw invalidCredentials();
    }
    const user = await repository.findUserByPhoneIndex(this.deps.pool, this.deps.indexer.compute("phone", phone.e164));
    if (user === undefined) {
      await this.deps.passwords.verifyAgainstDummy(params.password);
      throw invalidCredentials();
    }
    if (user.locked_until !== null && user.locked_until.getTime() > Date.now()) {
      await this.deps.passwords.verifyAgainstDummy(params.password);
      throw accountLocked(user.locked_until);
    }
    if (!(await this.deps.passwords.verify(user.password_hash, params.password))) {
      const lock = await withTransaction(this.deps.pool, { actor: { type: "system", id: "auth:login" } }, async (tx) => {
        const result = await repository.recordFailedLogin(tx, user.id);
        await repository.recordAudit(tx, {
          actorType: "system",
          actorId: null,
          action: "auth.login_failed",
          targetType: "user",
          targetId: user.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { reason: "bad_password" },
        });
        return result;
      });
      if (lock.lockedUntil !== null && lock.lockedUntil.getTime() > Date.now()) throw accountLocked(lock.lockedUntil);
      throw invalidCredentials();
    }
    if (user.status === "suspended" || user.status === "closed") {
      throw accountDisabled(user.status);
    }
    if (this.deps.passwords.needsRehash(user.password_hash)) {
      await repository.updatePasswordHash(this.deps.pool, user.id, await this.deps.passwords.hash(params.password));
    }

    // Appareil mobile déjà de confiance : la requête signée par sa clé
    // matérielle constitue le second facteur.
    if (params.client.type === "mobile" && "deviceId" in params.client) {
      const deviceId = params.client.deviceId;
      await this.deps.deviceBinding.verify(params.signedRequest, { deviceId, userId: user.id });
      const refresh = this.deps.tokens.generateRefreshToken();
      const session = await withTransaction(this.deps.pool, { actor: { type: "customer", id: user.id }, changeNote: "connexion appareil de confiance" }, async (tx) => {
        const created = await repository.createSession(tx, {
          userId: user.id,
          deviceId,
          audience: "mobile",
          assuranceLevel: 2,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          refreshTokenSha256: refresh.sha256,
        });
        await repository.recordSuccessfulLogin(tx, user.id);
        await repository.recordAudit(tx, {
          actorType: "customer",
          actorId: user.id,
          action: "auth.login_succeeded",
          targetType: "session",
          targetId: created.sessionId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { audience: "mobile", factor: "device_key", deviceId },
        });
        return created;
      });
      return this.authenticated({
        userId: user.id,
        sessionId: session.sessionId,
        deviceId,
        audience: "mobile",
        refreshToken: refresh.token,
        refreshTokenExpiresAt: session.refreshToken.expiresAt,
      });
    }

    const pendingDevice = params.client.type === "mobile" && "device" in params.client ? await this.verifyNewDevice(params.client.device) : undefined;
    const method: "sms_otp" | "totp" = user.mfa_totp_enabled_at === null ? "sms_otp" : "totp";

    const created = await withTransaction(this.deps.pool, { actor: { type: "customer", id: user.id } }, async (tx) => {
      const otp =
        method === "sms_otp"
          ? await this.deps.otp.create(tx, { purpose: "login", phoneE164: phone.e164, userId: user.id, ipAddress: context.ipAddress })
          : undefined;
      const result = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO identity.login_challenges (user_id, audience, method, otp_challenge_id, pending_device, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now() + make_interval(secs => $8))
         RETURNING id, expires_at`,
        [
          user.id,
          params.client.type,
          method,
          otp?.challengeId ?? null,
          pendingDevice === undefined ? null : JSON.stringify(serializePendingDevice(pendingDevice)),
          context.ipAddress ?? null,
          context.userAgent?.slice(0, 512) ?? null,
          LOGIN_CHALLENGE_TTL_SECONDS,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("création du défi de connexion impossible");
      return { challengeId: row.id, expiresAt: row.expires_at, otp };
    });

    if (created.otp !== undefined) {
      try {
        await this.deps.otp.sendCode(phone.e164, created.otp.code, user.preferred_locale);
      } catch (error: unknown) {
        if (error instanceof SmsDeliveryError) throw smsFailure(error);
        throw error;
      }
    }
    return { status: "second_factor_required", loginChallengeId: created.challengeId, method, expiresAt: created.expiresAt };
  }

  async completeLogin(params: { readonly loginChallengeId: string; readonly code: string }, context: RequestContext): Promise<AuthenticatedResult> {
    const refresh = this.deps.tokens.generateRefreshToken();

    const outcome = await withTransaction(this.deps.pool, { actor: { type: "system", id: "auth:login" } }, async (tx) => {
      const challenge = await tx.query<{
        user_id: string;
        audience: CustomerAudience;
        method: "sms_otp" | "totp";
        otp_challenge_id: string | null;
        pending_device: SerializedPendingDevice | null;
        attempts: number;
        max_attempts: number;
        expired: boolean;
        consumed_at: Date | null;
        user_status: string;
      }>(
        `SELECT lc.user_id, lc.audience, lc.method, lc.otp_challenge_id, lc.pending_device, lc.attempts, lc.max_attempts,
                lc.expires_at <= now() AS expired, lc.consumed_at, u.status AS user_status
           FROM identity.login_challenges lc
           JOIN identity.users u ON u.id = lc.user_id
          WHERE lc.id = $1
            FOR UPDATE OF lc`,
        [params.loginChallengeId],
      );
      const row = challenge.rows[0];
      if (row === undefined) return { kind: "failed" as const, reason: "not_found" };
      if (row.consumed_at !== null || row.expired) return { kind: "failed" as const, reason: "expired" };
      if (row.attempts >= row.max_attempts) return { kind: "failed" as const, reason: "exhausted" };
      if (row.user_status !== "active" && row.user_status !== "pending_verification") return { kind: "failed" as const, reason: "expired" };

      let verified: boolean;
      let failureReason = "invalid_code";
      if (row.method === "sms_otp") {
        if (row.otp_challenge_id === null) throw new Error("défi SMS sans code associé");
        const result = await this.deps.otp.verify(tx, { challengeId: row.otp_challenge_id, code: params.code, purpose: "login" });
        verified = result.ok;
        if (!result.ok) failureReason = result.reason;
      } else {
        verified = await this.deps.mfa.verifyAndConsumeTotp(tx, row.user_id, params.code);
      }

      if (!verified) {
        await tx.query("UPDATE identity.login_challenges SET attempts = attempts + 1 WHERE id = $1", [params.loginChallengeId]);
        const lock = await repository.recordFailedLogin(tx, row.user_id);
        await repository.recordAudit(tx, {
          actorType: "system",
          actorId: null,
          action: "auth.second_factor_failed",
          targetType: "user",
          targetId: row.user_id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { method: row.method },
        });
        const remaining = row.max_attempts - row.attempts - 1;
        return { kind: "failed" as const, reason: remaining <= 0 ? "exhausted" : failureReason, lockedUntil: lock.lockedUntil };
      }

      await tx.query("UPDATE identity.login_challenges SET attempts = attempts + 1, consumed_at = now() WHERE id = $1", [params.loginChallengeId]);
      const deviceId =
        row.pending_device === null ? null : await this.registerVerifiedDevice(tx, row.user_id, deserializePendingDevice(row.pending_device));
      const session = await repository.createSession(tx, {
        userId: row.user_id,
        deviceId,
        audience: row.audience,
        assuranceLevel: 2,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        refreshTokenSha256: refresh.sha256,
      });
      await repository.recordSuccessfulLogin(tx, row.user_id);
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: row.user_id,
        action: "auth.login_succeeded",
        targetType: "session",
        targetId: session.sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { audience: row.audience, factor: row.method, newDeviceId: deviceId },
      });
      return { kind: "authenticated" as const, userId: row.user_id, audience: row.audience, deviceId, session };
    });

    if (outcome.kind === "failed") {
      if ("lockedUntil" in outcome && outcome.lockedUntil !== null && outcome.lockedUntil.getTime() > Date.now()) {
        throw accountLocked(outcome.lockedUntil);
      }
      throw invalidCode(outcome.reason);
    }
    return this.authenticated({
      userId: outcome.userId,
      sessionId: outcome.session.sessionId,
      deviceId: outcome.deviceId,
      audience: outcome.audience,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: outcome.session.refreshToken.expiresAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Renouvellement
  // ---------------------------------------------------------------------------

  async refresh(params: { readonly refreshToken: string; readonly signedRequest: SignedRequestParts }, context: RequestContext): Promise<AuthenticatedResult> {
    const rejected = (): AppError =>
      new AppError("UNAUTHENTICATED", 401, "Session expirée", { detail: "Votre session a expiré. Reconnectez-vous." });
    if (!isWellFormedRefreshToken(params.refreshToken)) throw rejected();
    const next = this.deps.tokens.generateRefreshToken();

    const outcome = await withTransaction(this.deps.pool, { actor: { type: "system", id: "auth:refresh" } }, async (tx) => {
      const current = await repository.lockRefreshToken(tx, hashRefreshToken(params.refreshToken));
      if (current === undefined) return { kind: "rejected" as const };
      if (current.consumed_at !== null) {
        // Réutilisation d'un jeton déjà échangé : il a été copié. On révoque
        // toute la famille et la session, le titulaire devra se reconnecter.
        await tx.query("SELECT identity.revoke_refresh_token_family($1, $2)", [current.family_id, "refresh_token_reuse_detected"]);
        await repository.recordAudit(tx, {
          actorType: "system",
          actorId: null,
          action: "auth.refresh_token_reuse_detected",
          targetType: "session",
          targetId: current.session_id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
        });
        return { kind: "rejected" as const };
      }
      if (current.revoked_at !== null || current.expired || !current.session_active) return { kind: "rejected" as const };
      if (current.user_status !== "active" && current.user_status !== "pending_verification") return { kind: "rejected" as const };
      if (current.audience === "mobile") {
        if (current.device_id === null) return { kind: "rejected" as const };
        await this.deps.deviceBinding.verify(params.signedRequest, { deviceId: current.device_id, userId: current.user_id });
      }
      const rotated = await repository.rotateRefreshToken(tx, { current, newTokenSha256: next.sha256 });
      return { kind: "rotated" as const, current, rotated };
    });

    if (outcome.kind === "rejected") throw rejected();
    return this.authenticated({
      userId: outcome.current.user_id,
      sessionId: outcome.current.session_id,
      deviceId: outcome.current.device_id,
      audience: outcome.current.audience,
      refreshToken: next.token,
      refreshTokenExpiresAt: outcome.rotated.expiresAt,
      assuranceLevel: outcome.current.assurance_level,
    });
  }

  // ---------------------------------------------------------------------------
  // Sessions et appareils
  // ---------------------------------------------------------------------------

  async logout(userId: string, sessionId: string, context: RequestContext): Promise<void> {
    await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      await repository.revokeSession(tx, sessionId, "logout");
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.logout",
        targetType: "session",
        targetId: sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    });
  }

  listSessions(userId: string): Promise<readonly repository.SessionSummaryRow[]> {
    return repository.listActiveSessions(this.deps.pool, userId);
  }

  async revokeSession(userId: string, sessionId: string, context: RequestContext): Promise<void> {
    const revoked = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      const owned = await tx.query("SELECT 1 FROM identity.sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
      if (owned.rowCount !== 1) return false;
      await repository.revokeSession(tx, sessionId, "revoked_by_user");
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.session_revoked",
        targetType: "session",
        targetId: sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return true;
    });
    if (!revoked) throw new NotFoundError("Session introuvable.");
  }

  async revokeOtherSessions(userId: string, currentSessionId: string, context: RequestContext): Promise<number> {
    return withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      const count = await repository.revokeUserSessions(tx, { userId, reason: "revoked_by_user", exceptSessionId: currentSessionId });
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.other_sessions_revoked",
        targetType: "user",
        targetId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { count },
      });
      return count;
    });
  }

  /**
   * Clôture du compte par son titulaire (session renforcée, appareil signé,
   * mot de passe ressaisi). La base refuse tant qu'un solde est non nul ou
   * qu'un transfert est en cours, puis révoque tous les accès ; les données
   * sont conservées pour la durée légale.
   */
  async closeAccount(userId: string, password: string, context: RequestContext): Promise<void> {
    const user = await this.deps.pool.query<{ password_hash: string }>("SELECT password_hash FROM identity.users WHERE id = $1", [userId]);
    const passwordHash = user.rows[0]?.password_hash;
    if (passwordHash === undefined) throw new NotFoundError("Compte introuvable.");
    if (!(await this.deps.passwords.verify(passwordHash, password))) {
      const lock = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
        const result = await repository.recordFailedLogin(tx, userId);
        await repository.recordAudit(tx, {
          actorType: "customer",
          actorId: userId,
          action: "auth.account_closure_failed",
          targetType: "user",
          targetId: userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { reason: "bad_password" },
        });
        return result;
      });
      if (lock.lockedUntil !== null && lock.lockedUntil.getTime() > Date.now()) throw accountLocked(lock.lockedUntil);
      throw new AppError("INVALID_CREDENTIALS", 403, "Mot de passe incorrect", { detail: "Le mot de passe saisi est incorrect." });
    }
    await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId }, changeNote: "clôture du compte par le client" }, async (tx) => {
      const closed = await tx.query<{ revoked: number }>("SELECT identity.close_customer_account($1) AS revoked", [userId]);
      const revokedSessions = closed.rows[0]?.revoked ?? 0;
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.account_closed",
        targetType: "user",
        targetId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { revokedSessions },
      });
      await tx.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('user', $1, 'customers.closed', $2::jsonb, $3)`,
        [userId, JSON.stringify({ user_id: userId, revoked_sessions: revokedSessions }), `customer-closed:${userId}`],
      );
    });
  }

  listDevices(userId: string): Promise<readonly repository.DeviceSummaryRow[]> {
    return repository.listActiveDevices(this.deps.pool, userId);
  }

  async revokeDevice(userId: string, deviceId: string, context: RequestContext): Promise<void> {
    const revoked = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      if (!(await repository.revokeDevice(tx, userId, deviceId, "revoked_by_user"))) return false;
      await repository.revokeUserSessions(tx, { userId, deviceId, reason: "device_revoked" });
      await repository.recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.device_revoked",
        targetType: "device",
        targetId: deviceId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return true;
    });
    if (!revoked) throw new NotFoundError("Appareil introuvable.");
  }

  /** Session créée par une autre voie (passkey) : émission des jetons. */
  async createWebSessionForPasskey(db: Queryable, userId: string, context: RequestContext): Promise<{ readonly sessionId: string; readonly refreshToken: string; readonly refreshTokenExpiresAt: Date }> {
    const refresh = this.deps.tokens.generateRefreshToken();
    const session = await repository.createSession(db, {
      userId,
      deviceId: null,
      audience: "web",
      assuranceLevel: 2,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      refreshTokenSha256: refresh.sha256,
    });
    await repository.recordSuccessfulLogin(db, userId);
    return { sessionId: session.sessionId, refreshToken: refresh.token, refreshTokenExpiresAt: session.refreshToken.expiresAt };
  }

  async authenticated(params: {
    readonly userId: string;
    readonly sessionId: string;
    readonly deviceId: string | null;
    readonly audience: CustomerAudience;
    readonly refreshToken: string;
    readonly refreshTokenExpiresAt: Date;
    readonly assuranceLevel?: 1 | 2;
  }): Promise<AuthenticatedResult> {
    const access = await this.deps.tokens.issueAccessToken({
      subjectId: params.userId,
      sessionId: params.sessionId,
      audience: params.audience,
      assuranceLevel: params.assuranceLevel ?? 2,
      deviceId: params.deviceId,
    });
    return {
      status: "authenticated",
      userId: params.userId,
      sessionId: params.sessionId,
      deviceId: params.deviceId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: params.refreshToken,
      refreshTokenExpiresAt: params.refreshTokenExpiresAt,
    };
  }
}

/** Forme JSON d'un appareil attesté en attente (stocké dans login_challenges). */
interface SerializedPendingDevice {
  readonly challengeId: string;
  readonly platform: "ios" | "android";
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
  readonly publicKeySpki: string;
  readonly publicKeyAlgorithm: "ES256" | "EdDSA";
  readonly attestationType: "app_attest" | "play_integrity";
}

function serializePendingDevice(device: VerifiedDevice): SerializedPendingDevice {
  return {
    challengeId: device.challengeId,
    platform: device.insert.platform,
    name: device.insert.name,
    appVersion: device.insert.appVersion,
    osVersion: device.insert.osVersion,
    publicKeySpki: device.insert.publicKeySpki.toString("base64"),
    publicKeyAlgorithm: device.insert.publicKeyAlgorithm,
    attestationType: device.insert.attestationType,
  };
}

function deserializePendingDevice(device: SerializedPendingDevice): VerifiedDevice {
  return {
    challengeId: device.challengeId,
    insert: {
      platform: device.platform,
      name: device.name,
      appVersion: device.appVersion,
      osVersion: device.osVersion,
      publicKeySpki: Buffer.from(device.publicKeySpki, "base64"),
      publicKeyAlgorithm: device.publicKeyAlgorithm,
      attestationType: device.attestationType,
    },
  };
}

export type { RefreshTokenRow };
