import { randomBytes, randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey as JoseCryptoKey, JWTPayload } from "jose";
import pg from "pg";
import { pino } from "pino";
import type { Logger } from "pino";

import { createApp } from "../../src/app.js";
import type { AppDependencies } from "../../src/app.js";
import type { AppConfig, PrivateJwk, PublicJwk } from "../../src/config/env.js";
import { loadConfig } from "../../src/config/env.js";
import { createDatabasePool } from "../../src/db/pool.js";
import type { DatabasePool } from "../../src/db/pool.js";
import { createMemoryRateLimiter } from "../../src/middlewares/rateLimit.js";

export const ISSUER = "https://auth.transfertplus.test";
export const WEB_ORIGIN = "https://app.transfertplus.test";
export const ADMIN_ORIGIN = "https://admin.transfertplus.test";

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: JoseCryptoKey;
  readonly publicJwk: PublicJwk;
  readonly privateJwk: PrivateJwk;
}

export async function createSigningKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  if (jwk.x === undefined || privateJwk.d === undefined) throw new Error("clé Ed25519 incomplète");
  return {
    kid,
    privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA", use: "sig" },
    privateJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: privateJwk.d, kid, alg: "EdDSA", use: "sig" },
  };
}

export interface TestKeys {
  readonly customer: SigningKey;
  readonly admin: SigningKey;
}

export async function createTestKeys(): Promise<TestKeys> {
  return { customer: await createSigningKey("customer-key-2026-01"), admin: await createSigningKey("admin-key-2026-01") };
}

export function testDatabaseUrl(role?: "app_api"): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined) throw new Error("TEST_DATABASE_URL manquant");
  if (role === undefined) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c role=${role}`);
  return parsed.toString();
}

export function buildTestConfig(keys: TestKeys, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_ENV: "test",
    APP_VERSION: "1.2.3-test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: testDatabaseUrl("app_api"),
    DATABASE_SSL_MODE: "disable",
    REDIS_URL: "redis://127.0.0.1:6379",
    CORS_ALLOWED_ORIGINS: `${WEB_ORIGIN},${ADMIN_ORIGIN}`,
    JWT_ISSUER: ISSUER,
    JWT_CUSTOMER_PUBLIC_JWKS: JSON.stringify({ keys: [keys.customer.publicJwk] }),
    JWT_ADMIN_PUBLIC_JWKS: JSON.stringify({ keys: [keys.admin.publicJwk] }),
    PII_KEYRING: JSON.stringify({ activeKeyId: "pii-2026-01", keys: { "pii-2026-01": randomBytes(32).toString("base64") } }),
    BLIND_INDEX_KEY: randomBytes(32).toString("base64"),
    JWT_CUSTOMER_SIGNING_KEY: JSON.stringify(keys.customer.privateJwk),
    OTP_HMAC_KEY: randomBytes(32).toString("base64"),
    SMS_PROVIDER: "log",
    WEBAUTHN_RP_ID: "transfertplus.test",
    WEBAUTHN_ORIGINS: WEB_ORIGIN,
    PASSWORD_BREACH_CHECK: "disabled",
    ...overrides,
  });
}

export const silentLogger: Logger = pino({ level: "silent" });

export function buildTestApp(config: AppConfig, overrides: Partial<AppDependencies> = {}): ReturnType<typeof createApp> {
  return createApp({
    config,
    logger: silentLogger,
    healthChecks: [],
    globalRateLimiter: createMemoryRateLimiter({ keyPrefix: `test-${randomUUID()}`, points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }),
    ...overrides,
  });
}

export function createApiPool(config: AppConfig): DatabasePool {
  return createDatabasePool(config, silentLogger);
}

/** Connexion propriétaire (superutilisateur de test) pour préparer les données. */
export function createOwnerPool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
}

export interface TokenOptions {
  readonly key: SigningKey;
  readonly audience: "mobile" | "web" | "admin";
  readonly subject: string;
  readonly sessionId: string;
  readonly assuranceLevel?: 1 | 2;
  readonly deviceId?: string;
  readonly issuer?: string;
  readonly lifetimeSeconds?: number;
  readonly issuedAtOffsetSeconds?: number;
  readonly typ?: string;
  readonly extraClaims?: JWTPayload;
}

export async function signAccessToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000) + (options.issuedAtOffsetSeconds ?? 0);
  const payload: JWTPayload = {
    sid: options.sessionId,
    aal: options.assuranceLevel ?? 1,
    ...(options.deviceId === undefined ? {} : { did: options.deviceId }),
    ...options.extraClaims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: options.key.kid, typ: options.typ ?? "at+jwt" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience)
    .setSubject(options.subject)
    .setJti(randomBytes(16).toString("base64url"))
    .setIssuedAt(now)
    .setExpirationTime(now + (options.lifetimeSeconds ?? 600))
    .sign(options.key.privateKey);
}

export interface SeededCustomer {
  readonly userId: string;
  readonly deviceId: string;
  readonly mobileSessionId: string;
  readonly webSessionId: string;
}

let phoneCounter = 0;

/** Crée un client actif, un appareil de confiance et deux sessions (mobile, web). */
export async function seedCustomer(owner: pg.Pool, options: { readonly webAssuranceLevel?: 1 | 2 } = {}): Promise<SeededCustomer> {
  phoneCounter += 1;
  const user = await owner.query<{ id: string }>(
    `INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                 pii_key_id, status, phone_verified_at)
     VALUES (sha256(convert_to($1, 'UTF8')), '\\x01', 'FR', '$argon2id$v=19$test', 'FR', 'pii-2026-01', 'active', now())
     RETURNING id`,
    [`api-test-${randomUUID()}-${phoneCounter}`],
  );
  const userId = user.rows[0]!.id;
  const device = await owner.query<{ id: string }>(
    `INSERT INTO identity.devices (user_id, platform, device_name, public_key_spki, public_key_algorithm,
                                   attestation_type, attestation_verified_at, trusted_at)
     VALUES ($1, 'ios', 'iPhone de test', $2, 'ES256', 'app_attest', now(), now())
     RETURNING id`,
    [userId, randomBytes(91)],
  );
  const deviceId = device.rows[0]!.id;
  const sessions = await owner.query<{ id: string; audience: string }>(
    `INSERT INTO identity.sessions (user_id, device_id, audience, assurance_level, mfa_verified_at,
                                    idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, 'mobile', 2, now(), now() + interval '30 minutes', now() + interval '30 days'),
            ($1, NULL, 'web', $3::smallint, CASE WHEN $3::smallint = 2 THEN now() END, now() + interval '30 minutes', now() + interval '12 hours')
     RETURNING id, audience`,
    [userId, deviceId, options.webAssuranceLevel ?? 1],
  );
  const mobileSessionId = sessions.rows.find((row) => row.audience === "mobile")!.id;
  const webSessionId = sessions.rows.find((row) => row.audience === "web")!.id;
  return { userId, deviceId, mobileSessionId, webSessionId };
}

export interface SeededAdmin {
  readonly adminId: string;
  readonly sessionId: string;
}

/** Crée un membre du personnel actif avec un rôle et une session WebAuthn. */
export async function seedAdmin(owner: pg.Pool, role: "support" | "risk_manager" | "super_admin"): Promise<SeededAdmin> {
  const admin = await owner.query<{ id: string }>(
    `INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
     VALUES ($1, 'Agent de test', 'active', '$argon2id$v=19$test') RETURNING id`,
    [`agent-${randomUUID()}@transfertplus.example`],
  );
  const adminId = admin.rows[0]!.id;
  const granter = await owner.query<{ id: string }>(
    `INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
     VALUES ($1, 'Administrateur attributeur', 'active', '$argon2id$v=19$test') RETURNING id`,
    [`granter-${randomUUID()}@transfertplus.example`],
  );
  await owner.query(
    "INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id) VALUES ($1, $2, $3)",
    [adminId, role, granter.rows[0]!.id],
  );
  const credential = await owner.query<{ id: string }>(
    `INSERT INTO backoffice.webauthn_credentials (admin_user_id, credential_id, public_key_cose)
     VALUES ($1, $2, $3) RETURNING id`,
    [adminId, randomBytes(32), randomBytes(77)],
  );
  const session = await owner.query<{ id: string }>(
    `INSERT INTO backoffice.sessions (admin_user_id, webauthn_credential_id, ip_address, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, '10.0.0.1', now() + interval '15 minutes', now() + interval '8 hours') RETURNING id`,
    [adminId, credential.rows[0]!.id],
  );
  return { adminId, sessionId: session.rows[0]!.id };
}
