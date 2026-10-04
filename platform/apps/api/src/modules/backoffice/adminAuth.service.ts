import { createHash, randomBytes } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { importJWK, SignJWT } from "jose";
import type { CryptoKey as JoseCryptoKey } from "jose";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Queryable, TransactionClient } from "../../db/transaction.js";
import { AppError, AuthenticationError, ValidationError } from "../../lib/errors.js";
import type { PasswordService } from "../auth/password.service.js";
import { recordSystemAudit } from "./access.js";

/**
 * Authentification du personnel :
 *
 *   - Enrôlement par invitation à usage unique (jeton aléatoire de 256 bits,
 *     seule son empreinte est stockée) : mot de passe fort + clé WebAuthn
 *     liée à l'appareil (les passkeys synchronisées sont refusées), avec
 *     vérification de l'utilisateur. Le compte n'est actif qu'ensuite.
 *   - Connexion en deux temps : mot de passe (Argon2id, verrouillage après
 *     5 échecs) PUIS assertion WebAuthn liée au défi, au compte et à
 *     l'adresse IP. Les deux depuis une plage d'adresses autorisée.
 *   - Sessions courtes (inactivité ≤ 30 min, absolue ≤ 12 h), jetons d'accès
 *     de 10 minutes, jetons de renouvellement à usage unique : la
 *     réutilisation d'un jeton consommé révoque la session.
 */

const CHALLENGE_TTL_SECONDS = 300;
const ACCESS_TOKEN_LIFETIME_SECONDS = 600;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
export const STAFF_PASSWORD_MIN_LENGTH = 14;
const INVITATION_TOKEN_PATTERN = /^inv_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_PATTERN = /^art_[A-Za-z0-9_-]{43}$/;

export interface AdminLoginContext {
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly requestId: string;
}

export interface AdminTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly sessionExpiresAt: Date;
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function generateInvitationToken(): { readonly token: string; readonly sha256: Buffer } {
  const token = `inv_${randomBytes(32).toString("base64url")}`;
  return { token, sha256: sha256(token) };
}

function invalidCredentials(cause?: unknown): AppError {
  return new AppError("INVALID_CREDENTIALS", 401, "Identifiants refusés", { detail: "Identifiants ou clé de sécurité refusés.", cause });
}

function invitationInvalid(): AppError {
  return new AppError("VERIFICATION_EXPIRED", 410, "Invitation invalide", { detail: "Cette invitation est invalide, expirée ou déjà utilisée." });
}

interface InvitationRow {
  invitation_id: string;
  admin_user_id: string;
  email: string;
  full_name: string;
  network_allowed: boolean;
}

interface CredentialRow {
  id: string;
  admin_user_id: string;
  public_key_cose: Buffer;
  sign_count: string | bigint;
}

export class AdminAuthService {
  private readonly signingKey: Promise<JoseCryptoKey | Uint8Array>;

  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly passwords: PasswordService;
      readonly logger: Logger;
      readonly issuer: string;
      readonly admin: AppConfig["admin"];
    },
  ) {
    this.signingKey = importJWK({ ...deps.admin.signingKey }, "EdDSA");
  }

  // ---------------------------------------------------------------------------
  // Enrôlement
  // ---------------------------------------------------------------------------

  async enrollmentOptions(invitationToken: string, context: AdminLoginContext): Promise<{ readonly challengeId: string; readonly options: PublicKeyCredentialCreationOptionsJSON }> {
    const invitation = await this.findInvitation(this.deps.pool, invitationToken, context, false);
    const options = await generateRegistrationOptions({
      rpName: this.deps.admin.webauthn.rpName,
      rpID: this.deps.admin.webauthn.rpId,
      userName: invitation.email,
      userDisplayName: invitation.full_name,
      userID: new Uint8Array(Buffer.from(invitation.admin_user_id.replaceAll("-", ""), "hex")),
      attestationType: "direct",
      authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
      supportedAlgorithmIDs: [-8, -7],
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    const created = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO backoffice.webauthn_challenges (admin_user_id, ceremony, challenge, invitation_id, ip_address, expires_at)
       VALUES ($1, 'registration', $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
      [invitation.admin_user_id, options.challenge, invitation.invitation_id, context.ipAddress ?? null, CHALLENGE_TTL_SECONDS],
    );
    const challengeId = created.rows[0]?.id;
    if (challengeId === undefined) throw new Error("création du défi WebAuthn impossible");
    return { challengeId, options };
  }

  async completeEnrollment(
    params: { readonly invitationToken: string; readonly challengeId: string; readonly password: string; readonly response: RegistrationResponseJSON; readonly nickname?: string | undefined },
    context: AdminLoginContext,
  ): Promise<{ readonly adminId: string }> {
    await this.assertStaffPassword(params.password);
    const passwordHash = await this.deps.passwords.hash(params.password);

    return withTransaction(this.deps.pool, { actor: { type: "system", id: "admin-enrollment" } }, async (tx) => {
      const invitation = await this.findInvitation(tx, params.invitationToken, context, true);
      const challenge = await tx.query<{ challenge: string }>(
        `SELECT challenge FROM backoffice.webauthn_challenges
          WHERE id = $1 AND ceremony = 'registration' AND invitation_id = $2 AND admin_user_id = $3
            AND consumed_at IS NULL AND expires_at > now() AND ip_address = $4::inet
            FOR UPDATE`,
        [params.challengeId, invitation.invitation_id, invitation.admin_user_id, context.ipAddress ?? null],
      );
      const expected = challenge.rows[0]?.challenge;
      if (expected === undefined) throw invitationInvalid();
      await tx.query("UPDATE backoffice.webauthn_challenges SET consumed_at = now() WHERE id = $1", [params.challengeId]);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: params.response,
          expectedChallenge: expected,
          expectedOrigin: [...this.deps.admin.webauthn.origins],
          expectedRPID: this.deps.admin.webauthn.rpId,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-8, -7],
        });
      } catch (error: unknown) {
        throw invalidCredentials(error);
      }
      if (!verification.verified) throw invalidCredentials();
      const info = verification.registrationInfo;
      if (info.credentialDeviceType !== "singleDevice" || info.credentialBackedUp) {
        throw new ValidationError(
          [{ path: "body.response", message: "clé synchronisée refusée : utilisez une clé de sécurité matérielle" }],
          "Clé de sécurité refusée.",
        );
      }
      const allowed = this.deps.admin.webauthn.allowedAaguids;
      if (allowed.size > 0 && !allowed.has(info.aaguid.toLowerCase())) {
        throw new ValidationError([{ path: "body.response", message: "modèle de clé de sécurité non autorisé" }], "Clé de sécurité refusée.");
      }

      await tx.query(
        `INSERT INTO backoffice.webauthn_credentials (admin_user_id, credential_id, public_key_cose, sign_count, aaguid, backup_eligible, nickname)
         VALUES ($1, $2, $3, $4, $5, false, $6)`,
        [
          invitation.admin_user_id,
          Buffer.from(info.credential.id, "base64url"),
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          info.aaguid,
          params.nickname ?? null,
        ],
      );
      await tx.query("UPDATE backoffice.invitations SET consumed_at = now() WHERE id = $1", [invitation.invitation_id]);
      await tx.query("UPDATE backoffice.admin_users SET password_hash = $2, status = 'active' WHERE id = $1", [invitation.admin_user_id, passwordHash]);
      await recordSystemAudit(tx, {
        actorType: "admin",
        actorId: invitation.admin_user_id,
        action: "backoffice.admin_enrolled",
        targetType: "admin_user",
        targetId: invitation.admin_user_id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { aaguid: info.aaguid },
      });
      return { adminId: invitation.admin_user_id };
    });
  }

  private async findInvitation(db: Queryable, token: string, context: AdminLoginContext, lock: boolean): Promise<InvitationRow> {
    if (!INVITATION_TOKEN_PATTERN.test(token)) throw invitationInvalid();
    const result = await db.query<InvitationRow>(
      `SELECT i.id AS invitation_id, u.id AS admin_user_id, u.email, u.full_name,
              COALESCE($2::inet <<= ANY (u.allowed_ip_ranges), false) AS network_allowed
         FROM backoffice.invitations i
         JOIN backoffice.admin_users u ON u.id = i.admin_user_id
        WHERE i.token_sha256 = $1 AND i.consumed_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > now() AND u.status = 'invited'
          ${lock ? "FOR UPDATE OF i" : ""}`,
      [sha256(token), context.ipAddress ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw invitationInvalid();
    if (!row.network_allowed) throw new AppError("FORBIDDEN", 403, "Réseau non autorisé", { detail: "Enrôlement refusé depuis ce réseau." });
    return row;
  }

  private async assertStaffPassword(password: string): Promise<void> {
    if (Array.from(password).length < STAFF_PASSWORD_MIN_LENGTH) {
      throw new ValidationError(
        [{ path: "body.password", message: `au moins ${STAFF_PASSWORD_MIN_LENGTH.toString()} caractères pour le personnel` }],
        "Le mot de passe ne respecte pas la politique de sécurité.",
      );
    }
    await this.deps.passwords.assertAcceptable(password, {});
  }

  // ---------------------------------------------------------------------------
  // Connexion
  // ---------------------------------------------------------------------------

  async startLogin(email: string, password: string, context: AdminLoginContext): Promise<{ readonly challengeId: string; readonly options: PublicKeyCredentialRequestOptionsJSON }> {
    const normalized = email.trim().toLowerCase();
    // Un compte actif a toujours un mot de passe (contrainte admin_users_active_has_password).
    const found = await this.deps.pool.query<{ id: string; password_hash: string; locked: boolean; network_allowed: boolean }>(
      `SELECT id, password_hash, COALESCE(locked_until > now(), false) AS locked,
              COALESCE($2::inet <<= ANY (allowed_ip_ranges), false) AS network_allowed
         FROM backoffice.admin_users WHERE email = $1 AND status = 'active'`,
      [normalized, context.ipAddress ?? null],
    );
    const admin = found.rows[0];
    if (admin === undefined) {
      await this.deps.passwords.verifyAgainstDummy(password);
      await this.auditLoginFailure(null, "unknown_account", context, { email_sha256: sha256(normalized).toString("hex") });
      throw invalidCredentials();
    }
    if (!admin.network_allowed) {
      await this.deps.passwords.verifyAgainstDummy(password);
      await this.auditLoginFailure(admin.id, "network_denied", context, {});
      throw invalidCredentials();
    }
    if (admin.locked) {
      await this.deps.passwords.verifyAgainstDummy(password);
      await this.auditLoginFailure(admin.id, "locked", context, {});
      throw new AppError("ACCOUNT_LOCKED", 423, "Compte verrouillé", { detail: "Trop de tentatives : réessayez plus tard ou contactez un administrateur." });
    }
    if (!(await this.deps.passwords.verify(admin.password_hash, password))) {
      await withTransaction(this.deps.pool, { actor: { type: "system", id: "admin-login" } }, async (tx) => {
        await tx.query(
          `UPDATE backoffice.admin_users
              SET failed_login_count = failed_login_count + 1,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [admin.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
        );
        await this.auditLoginFailure(admin.id, "bad_password", context, {}, tx);
      });
      throw invalidCredentials();
    }

    const credentials = await this.deps.pool.query<{ credential_id: Buffer }>(
      "SELECT credential_id FROM backoffice.webauthn_credentials WHERE admin_user_id = $1 AND revoked_at IS NULL",
      [admin.id],
    );
    if (credentials.rows.length === 0) {
      await this.auditLoginFailure(admin.id, "no_security_key", context, {});
      throw invalidCredentials();
    }
    const options = await generateAuthenticationOptions({
      rpID: this.deps.admin.webauthn.rpId,
      userVerification: "required",
      allowCredentials: credentials.rows.map((row) => ({ id: row.credential_id.toString("base64url") })),
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    const created = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO backoffice.webauthn_challenges (admin_user_id, ceremony, challenge, ip_address, expires_at)
       VALUES ($1, 'authentication', $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
      [admin.id, options.challenge, context.ipAddress ?? null, CHALLENGE_TTL_SECONDS],
    );
    const challengeId = created.rows[0]?.id;
    if (challengeId === undefined) throw new Error("création du défi WebAuthn impossible");
    return { challengeId, options };
  }

  async completeLogin(params: { readonly challengeId: string; readonly response: AuthenticationResponseJSON }, context: AdminLoginContext): Promise<AdminTokens> {
    const session = await withTransaction(this.deps.pool, { actor: { type: "system", id: "admin-login" } }, async (tx) => {
      const challenge = await tx.query<{ admin_user_id: string; challenge: string }>(
        `SELECT admin_user_id, challenge FROM backoffice.webauthn_challenges
          WHERE id = $1 AND ceremony = 'authentication' AND consumed_at IS NULL AND expires_at > now()
            AND ip_address = $2::inet
            FOR UPDATE`,
        [params.challengeId, context.ipAddress ?? null],
      );
      const row = challenge.rows[0];
      if (row === undefined) throw new AppError("VERIFICATION_EXPIRED", 410, "Défi expiré", { detail: "Recommencez la connexion." });
      await tx.query("UPDATE backoffice.webauthn_challenges SET consumed_at = now() WHERE id = $1", [params.challengeId]);

      const found = await tx.query<CredentialRow>(
        `SELECT c.id, c.admin_user_id, c.public_key_cose, c.sign_count
           FROM backoffice.webauthn_credentials c
           JOIN backoffice.admin_users u ON u.id = c.admin_user_id
          WHERE c.credential_id = $1 AND c.admin_user_id = $2 AND c.revoked_at IS NULL
            AND u.status = 'active' AND COALESCE($3::inet <<= ANY (u.allowed_ip_ranges), false)
            FOR UPDATE OF c`,
        [Buffer.from(params.response.id, "base64url"), row.admin_user_id, context.ipAddress ?? null],
      );
      const credential = found.rows[0];
      if (credential === undefined) throw invalidCredentials();

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: params.response,
          expectedChallenge: row.challenge,
          expectedOrigin: [...this.deps.admin.webauthn.origins],
          expectedRPID: this.deps.admin.webauthn.rpId,
          credential: {
            id: params.response.id,
            publicKey: new Uint8Array(credential.public_key_cose),
            counter: Number(credential.sign_count),
          },
          requireUserVerification: true,
        });
      } catch (error: unknown) {
        throw invalidCredentials(error);
      }
      if (!verification.verified) throw invalidCredentials();
      // Compteur monotone : une régression (clé clonée) a déjà été refusée par la vérification.
      const newCounter = verification.authenticationInfo.newCounter;
      await tx.query("UPDATE backoffice.webauthn_credentials SET sign_count = GREATEST(sign_count, $2), last_used_at = now() WHERE id = $1", [credential.id, newCounter]);
      await tx.query("UPDATE backoffice.admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [credential.admin_user_id]);

      const created = await tx.query<{ id: string; absolute_expires_at: Date }>(
        `INSERT INTO backoffice.sessions (admin_user_id, webauthn_credential_id, ip_address, user_agent, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + make_interval(secs => $6))
         RETURNING id, absolute_expires_at`,
        [
          credential.admin_user_id,
          credential.id,
          context.ipAddress ?? null,
          context.userAgent?.slice(0, 512) ?? null,
          Math.min(this.deps.admin.sessionIdleMs, this.deps.admin.sessionAbsoluteMs) / 1000,
          this.deps.admin.sessionAbsoluteMs / 1000,
        ],
      );
      const sessionRow = created.rows[0];
      if (sessionRow === undefined) throw new Error("création de session impossible");
      const refreshToken = await this.insertRefreshToken(tx, sessionRow.id, null, sessionRow.absolute_expires_at);
      await recordSystemAudit(tx, {
        actorType: "admin",
        actorId: credential.admin_user_id,
        action: "backoffice.login_succeeded",
        targetType: "admin_session",
        targetId: sessionRow.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return { adminId: credential.admin_user_id, sessionId: sessionRow.id, refreshToken, sessionExpiresAt: sessionRow.absolute_expires_at };
    });
    return this.tokens(session);
  }

  async refresh(refreshToken: string, context: AdminLoginContext): Promise<AdminTokens> {
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw new AuthenticationError("Session expirée ou révoquée.", { reason: "malformed_refresh_token" });
    const outcome = await withTransaction(this.deps.pool, { actor: { type: "system", id: "admin-refresh" } }, async (tx) => {
      const found = await tx.query<{
        id: string;
        session_id: string;
        consumed: boolean;
        expired: boolean;
        admin_user_id: string;
        session_active: boolean;
        network_allowed: boolean;
        absolute_expires_at: Date;
      }>(
        `SELECT t.id, t.session_id, t.consumed_at IS NOT NULL AS consumed, t.expires_at <= now() AS expired,
                s.admin_user_id, s.absolute_expires_at,
                (s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND u.status = 'active') AS session_active,
                COALESCE($2::inet <<= ANY (u.allowed_ip_ranges), false) AS network_allowed
           FROM backoffice.refresh_tokens t
           JOIN backoffice.sessions s ON s.id = t.session_id
           JOIN backoffice.admin_users u ON u.id = s.admin_user_id
          WHERE t.token_sha256 = $1
            FOR UPDATE OF t, s`,
        [sha256(refreshToken), context.ipAddress ?? null],
      );
      const row = found.rows[0];
      if (row === undefined) return { kind: "invalid" as const };
      if (row.consumed) {
        // Réutilisation : jeton volé ou rejoué. La session entière tombe.
        await tx.query(
          "UPDATE backoffice.sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse' WHERE id = $1 AND revoked_at IS NULL",
          [row.session_id],
        );
        await recordSystemAudit(tx, {
          actorType: "system",
          actorId: "admin-refresh",
          action: "backoffice.refresh_token_reused",
          targetType: "admin_session",
          targetId: row.session_id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { admin_user_id: row.admin_user_id },
        });
        return { kind: "reused" as const };
      }
      if (row.expired || !row.session_active || !row.network_allowed) return { kind: "invalid" as const };
      await tx.query("UPDATE backoffice.refresh_tokens SET consumed_at = now() WHERE id = $1", [row.id]);
      await tx.query(
        `UPDATE backoffice.sessions
            SET last_used_at = now(), idle_expires_at = LEAST(now() + make_interval(secs => $2), absolute_expires_at)
          WHERE id = $1`,
        [row.session_id, this.deps.admin.sessionIdleMs / 1000],
      );
      const next = await this.insertRefreshToken(tx, row.session_id, row.id, row.absolute_expires_at);
      return { kind: "ok" as const, adminId: row.admin_user_id, sessionId: row.session_id, refreshToken: next, sessionExpiresAt: row.absolute_expires_at };
    });
    if (outcome.kind !== "ok") throw new AuthenticationError("Session expirée ou révoquée.", { reason: `refresh_${outcome.kind}` });
    return this.tokens(outcome);
  }

  async logout(adminId: string, sessionId: string, context: AdminLoginContext): Promise<void> {
    await withTransaction(this.deps.pool, { actor: { type: "admin", id: adminId } }, async (tx) => {
      await tx.query(
        "UPDATE backoffice.sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND admin_user_id = $2 AND revoked_at IS NULL",
        [sessionId, adminId],
      );
      await recordSystemAudit(tx, {
        actorType: "admin",
        actorId: adminId,
        action: "backoffice.logout",
        targetType: "admin_session",
        targetId: sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    });
  }

  private async insertRefreshToken(tx: TransactionClient, sessionId: string, parentId: string | null, expiresAt: Date): Promise<string> {
    const token = `art_${randomBytes(32).toString("base64url")}`;
    await tx.query(
      `INSERT INTO backoffice.refresh_tokens (session_id, parent_id, token_sha256, expires_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, parentId, sha256(token), expiresAt],
    );
    return token;
  }

  private async tokens(session: { readonly adminId: string; readonly sessionId: string; readonly refreshToken: string; readonly sessionExpiresAt: Date }): Promise<AdminTokens> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS;
    const accessToken = await new SignJWT({ sid: session.sessionId, aal: 2 })
      .setProtectedHeader({ alg: "EdDSA", kid: this.deps.admin.signingKey.kid, typ: "at+jwt" })
      .setIssuer(this.deps.issuer)
      .setAudience("admin")
      .setSubject(session.adminId)
      .setJti(randomBytes(18).toString("base64url"))
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(await this.signingKey);
    return {
      accessToken,
      accessTokenExpiresAt: new Date(expiresAt * 1000),
      refreshToken: session.refreshToken,
      sessionExpiresAt: session.sessionExpiresAt,
    };
  }

  private async auditLoginFailure(
    adminId: string | null,
    reason: string,
    context: AdminLoginContext,
    metadata: Readonly<Record<string, unknown>>,
    db: Queryable = this.deps.pool,
  ): Promise<void> {
    await recordSystemAudit(db, {
      actorType: "system",
      actorId: "admin-login",
      action: "backoffice.login_failed",
      targetType: "admin_user",
      targetId: adminId ?? "unknown",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      requestId: context.requestId,
      metadata: { reason, ...metadata },
    });
  }
}
