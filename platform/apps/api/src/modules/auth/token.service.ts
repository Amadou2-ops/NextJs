import { createHash, randomBytes } from "node:crypto";

import { importJWK, SignJWT } from "jose";
import type { CryptoKey as JoseCryptoKey } from "jose";

import type { PrivateJwk } from "../../config/env.js";
import type { CustomerAudience } from "../../auth/accessToken.js";

/**
 * Émission des jetons clients.
 *
 * - Jeton d'accès : JWT `at+jwt` signé EdDSA, 10 minutes, porteur de
 *   l'identifiant de session (sid), du niveau d'assurance (aal) et, sur
 *   mobile, de l'appareil (did). Vérifié par AccessTokenVerifier.
 * - Jeton de renouvellement : 256 bits aléatoires opaques, préfixés « rt_ ».
 *   Seule son empreinte SHA-256 est stockée ; il est à usage unique.
 *
 * Rotation de la clé de signature : publier d'abord la nouvelle clé publique
 * dans JWT_CUSTOMER_PUBLIC_JWKS, attendre l'expiration des caches JWKS
 * (5 min), basculer JWT_CUSTOMER_SIGNING_KEY, puis retirer l'ancienne clé
 * publique après la durée de vie maximale d'un jeton d'accès.
 */

export const ACCESS_TOKEN_LIFETIME_SECONDS = 600;
const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{43}$/;

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GeneratedRefreshToken {
  readonly token: string;
  readonly sha256: Buffer;
}

export class TokenService {
  private readonly signingKey: Promise<JoseCryptoKey | Uint8Array>;

  constructor(
    private readonly issuer: string,
    private readonly jwk: PrivateJwk,
  ) {
    this.signingKey = importJWK({ ...jwk }, "EdDSA");
  }

  async issueAccessToken(params: {
    readonly subjectId: string;
    readonly sessionId: string;
    readonly audience: CustomerAudience;
    readonly assuranceLevel: 1 | 2;
    readonly deviceId: string | null;
  }): Promise<IssuedAccessToken> {
    if (params.audience === "mobile" && params.deviceId === null) {
      throw new Error("un jeton mobile doit être lié à un appareil");
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS;
    const token = await new SignJWT({
      sid: params.sessionId,
      aal: params.assuranceLevel,
      ...(params.deviceId === null ? {} : { did: params.deviceId }),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.jwk.kid, typ: "at+jwt" })
      .setIssuer(this.issuer)
      .setAudience(params.audience)
      .setSubject(params.subjectId)
      .setJti(randomBytes(18).toString("base64url"))
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(await this.signingKey);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  generateRefreshToken(): GeneratedRefreshToken {
    const token = `rt_${randomBytes(32).toString("base64url")}`;
    return { token, sha256: hashRefreshToken(token) };
  }
}

export function isWellFormedRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_PATTERN.test(token);
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
