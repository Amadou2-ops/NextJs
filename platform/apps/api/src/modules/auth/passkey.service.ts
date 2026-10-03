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

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { recordAudit } from "./auth.repository.js";
import type { AuthenticatedResult, AuthService, RequestContext } from "./auth.service.js";

/**
 * Passkeys (WebAuthn) pour le site web client : connexion sans mot de passe,
 * résistante à l'hameçonnage (liée au domaine). Vérification de présence ET
 * d'identification de l'utilisateur (biométrie ou code de l'appareil)
 * exigée : une passkey vaut à elle seule deux facteurs (niveau 2).
 */

const CHALLENGE_TTL_SECONDS = 300;

type Transport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
const TRANSPORTS: ReadonlySet<string> = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

function isTransport(value: string): value is Transport {
  return TRANSPORTS.has(value);
}

export interface PasskeyConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
}

interface ChallengeRow {
  user_id: string | null;
  challenge: string;
}

function verificationFailed(cause?: unknown): AppError {
  return new AppError("INVALID_CREDENTIALS", 401, "Passkey refusée", { detail: "La vérification de la passkey a échoué.", cause });
}

export class PasskeyService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: PasskeyConfig,
    private readonly auth: AuthService,
  ) {}

  private async storeChallenge(ceremony: "registration" | "authentication", challenge: string, userId: string | null): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO identity.webauthn_challenges (user_id, ceremony, challenge, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
      [userId, ceremony, challenge, CHALLENGE_TTL_SECONDS],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("création du défi WebAuthn impossible");
    return id;
  }

  async registrationOptions(userId: string): Promise<{ readonly challengeId: string; readonly options: PublicKeyCredentialCreationOptionsJSON }> {
    const user = await this.pool.query<{ customer_number: string | bigint }>("SELECT customer_number FROM identity.users WHERE id = $1", [userId]);
    const customerNumber = user.rows[0]?.customer_number;
    if (customerNumber === undefined) throw new NotFoundError("Client introuvable.");
    const existing = await this.pool.query<{ credential_id: Buffer; transports: string[] }>(
      "SELECT credential_id, transports FROM identity.webauthn_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userName: `client-${String(customerNumber)}`,
      userDisplayName: `Client ${String(customerNumber)}`,
      userID: new Uint8Array(Buffer.from(userId.replaceAll("-", ""), "hex")),
      attestationType: "none",
      excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id.toString("base64url"), transports: row.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    const challengeId = await this.storeChallenge("registration", options.challenge, userId);
    return { challengeId, options };
  }

  async verifyRegistration(userId: string, params: { readonly challengeId: string; readonly response: RegistrationResponseJSON; readonly nickname?: string }, context: RequestContext): Promise<{ readonly credentialId: string }> {
    return withTransaction(this.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      const challenge = await tx.query<ChallengeRow>(
        `SELECT user_id, challenge FROM identity.webauthn_challenges
          WHERE id = $1 AND ceremony = 'registration' AND consumed_at IS NULL AND expires_at > now()
            FOR UPDATE`,
        [params.challengeId],
      );
      const row = challenge.rows[0];
      if (row?.user_id !== userId) throw new AppError("VERIFICATION_EXPIRED", 410, "Défi expiré", { detail: "Recommencez l'enregistrement de la passkey." });
      await tx.query("UPDATE identity.webauthn_challenges SET consumed_at = now() WHERE id = $1", [params.challengeId]);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: params.response,
          expectedChallenge: row.challenge,
          expectedOrigin: [...this.config.origins],
          expectedRPID: this.config.rpId,
          requireUserVerification: true,
        });
      } catch (error: unknown) {
        throw verificationFailed(error);
      }
      if (!verification.verified) throw verificationFailed();
      const info = verification.registrationInfo;
      await tx.query(
        `INSERT INTO identity.webauthn_credentials (user_id, credential_id, public_key_cose, sign_count, transports, aaguid,
                                                    backup_eligible, backup_state, nickname)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          Buffer.from(info.credential.id, "base64url"),
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          info.credential.transports ?? [],
          info.aaguid,
          info.credentialDeviceType === "multiDevice",
          info.credentialBackedUp,
          params.nickname ?? null,
        ],
      );
      await recordAudit(tx, {
        actorType: "customer",
        actorId: userId,
        action: "auth.passkey_registered",
        targetType: "user",
        targetId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { aaguid: info.aaguid, backedUp: info.credentialBackedUp },
      });
      return { credentialId: info.credential.id };
    });
  }

  async authenticationOptions(): Promise<{ readonly challengeId: string; readonly options: PublicKeyCredentialRequestOptionsJSON }> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: "required",
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    const challengeId = await this.storeChallenge("authentication", options.challenge, null);
    return { challengeId, options };
  }

  async verifyAuthentication(params: { readonly challengeId: string; readonly response: AuthenticationResponseJSON }, context: RequestContext): Promise<AuthenticatedResult> {
    const session = await withTransaction(this.pool, { actor: { type: "system", id: "auth:passkey" } }, async (tx) => {
      const challenge = await tx.query<ChallengeRow>(
        `SELECT user_id, challenge FROM identity.webauthn_challenges
          WHERE id = $1 AND ceremony = 'authentication' AND consumed_at IS NULL AND expires_at > now()
            FOR UPDATE`,
        [params.challengeId],
      );
      const row = challenge.rows[0];
      if (row === undefined) throw new AppError("VERIFICATION_EXPIRED", 410, "Défi expiré", { detail: "Recommencez la connexion." });
      await tx.query("UPDATE identity.webauthn_challenges SET consumed_at = now() WHERE id = $1", [params.challengeId]);

      const credential = await tx.query<{ id: string; user_id: string; public_key_cose: Buffer; sign_count: string | bigint; transports: string[]; user_status: string }>(
        `SELECT c.id, c.user_id, c.public_key_cose, c.sign_count, c.transports, u.status AS user_status
           FROM identity.webauthn_credentials c
           JOIN identity.users u ON u.id = c.user_id
          WHERE c.credential_id = $1 AND c.revoked_at IS NULL
            FOR UPDATE OF c`,
        [Buffer.from(params.response.id, "base64url")],
      );
      const stored = credential.rows[0];
      if (stored === undefined) throw verificationFailed();
      if (stored.user_status !== "active") throw verificationFailed();

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: params.response,
          expectedChallenge: row.challenge,
          expectedOrigin: [...this.config.origins],
          expectedRPID: this.config.rpId,
          credential: {
            id: params.response.id,
            publicKey: new Uint8Array(stored.public_key_cose),
            counter: Number(stored.sign_count),
            transports: stored.transports.filter(isTransport),
          },
          requireUserVerification: true,
        });
      } catch (error: unknown) {
        throw verificationFailed(error);
      }
      if (!verification.verified) throw verificationFailed();

      await tx.query(
        "UPDATE identity.webauthn_credentials SET sign_count = GREATEST(sign_count, $2), last_used_at = now() WHERE id = $1",
        [stored.id, verification.authenticationInfo.newCounter],
      );
      const created = await this.auth.createWebSessionForPasskey(tx, stored.user_id, context);
      await recordAudit(tx, {
        actorType: "customer",
        actorId: stored.user_id,
        action: "auth.login_succeeded",
        targetType: "session",
        targetId: created.sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
        metadata: { audience: "web", factor: "passkey" },
      });
      return { userId: stored.user_id, ...created };
    });

    return this.auth.authenticated({
      userId: session.userId,
      sessionId: session.sessionId,
      deviceId: null,
      audience: "web",
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    });
  }
}
