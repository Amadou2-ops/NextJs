import { createLocalJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";

import type { PublicJwks } from "../config/env.js";
import { AuthenticationError } from "../lib/errors.js";

/**
 * Vérification des jetons d'accès (JWT RFC 9068, `typ: at+jwt`), signés en
 * EdDSA (Ed25519). L'émission et la rotation des clés privées relèvent du
 * module d'authentification (phase 3) ; l'API ne détient ici que les clés
 * publiques.
 *
 * Règles :
 *   - algorithme EdDSA uniquement (`none`, HS256, RS256… sont refusés) ;
 *   - émetteur, audience, expiration, date d'émission et âge maximal vérifiés ;
 *   - les audiences client (mobile, web) et personnel (admin) sont vérifiées
 *     avec des jeux de clés DISTINCTS : un jeton client ne peut jamais être
 *     accepté sur une route d'administration, même signé par une clé valide.
 */

export const CUSTOMER_AUDIENCES = ["mobile", "web"] as const;
export type CustomerAudience = (typeof CUSTOMER_AUDIENCES)[number];
export type Audience = CustomerAudience | "admin";

export interface AccessTokenClaims {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly audience: Audience;
  readonly assuranceLevel: 1 | 2;
  readonly deviceId: string | undefined;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_TOLERANCE_SECONDS = 5;
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{43,512}$/;

const claimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  jti: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  aal: z.union([z.literal(1), z.literal(2)]),
  did: z.uuid().optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export class AccessTokenVerifier {
  private readonly customerKeys: JWTVerifyGetKey;
  private readonly adminKeys: JWTVerifyGetKey;

  constructor(
    private readonly issuer: string,
    customerJwks: PublicJwks,
    adminJwks: PublicJwks,
  ) {
    this.customerKeys = createLocalJWKSet({ keys: customerJwks.keys.map((key) => ({ ...key })) });
    this.adminKeys = createLocalJWKSet({ keys: adminJwks.keys.map((key) => ({ ...key })) });
  }

  /**
   * Vérifie un jeton pour l'une des audiences autorisées. Les audiences client
   * et admin ne peuvent pas être mélangées dans un même appel.
   */
  async verify(token: string, allowedAudiences: readonly Audience[]): Promise<AccessTokenClaims> {
    if (allowedAudiences.length === 0) throw new Error("au moins une audience doit être autorisée");
    const isAdmin = allowedAudiences.includes("admin");
    if (isAdmin && allowedAudiences.length > 1) {
      throw new Error("les audiences client et admin ne peuvent pas être acceptées par la même route");
    }
    if (!COMPACT_JWT_PATTERN.test(token)) {
      throw new AuthenticationError("Jeton d'accès invalide.", { reason: "malformed_token" });
    }

    let payload: Record<string, unknown>;
    let audience: Audience;
    try {
      const result = await jwtVerify(token, isAdmin ? this.adminKeys : this.customerKeys, {
        issuer: this.issuer,
        audience: [...allowedAudiences],
        algorithms: ["EdDSA"],
        typ: "at+jwt",
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
        requiredClaims: ["sub", "sid", "jti", "aal", "iat", "exp", "aud", "iss"],
      });
      payload = result.payload;
      const tokenAudience = Array.isArray(result.payload.aud) ? result.payload.aud : [result.payload.aud];
      if (tokenAudience.length !== 1) {
        throw new AuthenticationError("Jeton d'accès invalide.", { reason: "multiple_audiences" });
      }
      const [single] = tokenAudience;
      if (single === undefined || !(allowedAudiences as readonly string[]).includes(single)) {
        throw new AuthenticationError("Jeton d'accès invalide.", { reason: "audience_mismatch" });
      }
      audience = single as Audience;
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError(
        error instanceof joseErrors.JWTExpired ? "Jeton d'accès expiré." : "Jeton d'accès invalide.",
        { reason: joseReason(error) },
      );
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new AuthenticationError("Jeton d'accès invalide.", { reason: "invalid_claims" });
    }
    if (audience === "mobile" && claims.data.did === undefined) {
      throw new AuthenticationError("Jeton d'accès invalide.", { reason: "mobile_token_without_device" });
    }
    if (claims.data.exp - claims.data.iat > ACCESS_TOKEN_MAX_AGE_SECONDS) {
      throw new AuthenticationError("Jeton d'accès invalide.", { reason: "lifetime_too_long" });
    }

    return {
      subjectId: claims.data.sub,
      sessionId: claims.data.sid,
      tokenId: claims.data.jti,
      audience,
      assuranceLevel: claims.data.aal,
      deviceId: claims.data.did,
      issuedAt: new Date(claims.data.iat * 1000),
      expiresAt: new Date(claims.data.exp * 1000),
    };
  }
}

function joseReason(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return "expired";
  if (error instanceof joseErrors.JWTClaimValidationFailed) return `claim_${error.claim}_${error.reason}`;
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return "bad_signature";
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return "algorithm_not_allowed";
  if (error instanceof joseErrors.JWKSNoMatchingKey) return "unknown_key";
  if (error instanceof joseErrors.JWSInvalid || error instanceof joseErrors.JWTInvalid) return "malformed_token";
  return "verification_failed";
}
