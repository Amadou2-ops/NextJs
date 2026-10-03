import type { Queryable } from "../../db/transaction.js";

/**
 * Accès SQL du module d'authentification. Toutes les fonctions reçoivent un
 * Queryable (pool ou transaction) : la frontière transactionnelle est décidée
 * par le service, jamais ici.
 */

export type CustomerAudience = "mobile" | "web";

export const SESSION_POLICY: Readonly<Record<CustomerAudience, { readonly idleSeconds: number; readonly absoluteSeconds: number }>> = {
  // Application mobile : session longue, liée à la clé matérielle de l'appareil.
  mobile: { idleSeconds: 30 * 24 * 3600, absoluteSeconds: 90 * 24 * 3600 },
  // Site web : session courte (navigateur partagé possible).
  web: { idleSeconds: 30 * 60, absoluteSeconds: 12 * 3600 },
};

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_SECONDS = 15 * 60;
const LOCKOUT_MAX_SECONDS = 24 * 3600;

export interface UserCredentialsRow {
  readonly id: string;
  readonly status: "pending_verification" | "active" | "suspended" | "closed";
  readonly password_hash: string;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
  readonly mfa_totp_enabled_at: Date | null;
  readonly preferred_locale: string;
}

export async function findUserByPhoneIndex(db: Queryable, phoneBidx: Buffer): Promise<UserCredentialsRow | undefined> {
  const result = await db.query<UserCredentialsRow>(
    `SELECT id, status, password_hash, failed_login_count, locked_until, mfa_totp_enabled_at, preferred_locale
       FROM identity.users WHERE phone_bidx = $1`,
    [phoneBidx],
  );
  return result.rows[0];
}

export async function insertUser(
  db: Queryable,
  params: {
    readonly id: string;
    readonly phoneBidx: Buffer;
    readonly phoneEnc: Buffer;
    readonly phoneCountry: string;
    readonly passwordHash: string;
    readonly countryOfResidence: string;
    readonly preferredLocale: string;
    readonly piiKeyId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO identity.users (id, phone_bidx, phone_enc, phone_country, phone_verified_at, password_hash,
                                 country_of_residence, preferred_locale, pii_key_id, status)
     VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, 'active')`,
    [params.id, params.phoneBidx, params.phoneEnc, params.phoneCountry, params.passwordHash, params.countryOfResidence, params.preferredLocale, params.piiKeyId],
  );
}

/** Incrémente le compteur d'échecs ; verrouillage exponentiel au-delà du seuil. */
export async function recordFailedLogin(db: Queryable, userId: string): Promise<{ readonly lockedUntil: Date | null }> {
  const result = await db.query<{ locked_until: Date | null }>(
    `UPDATE identity.users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
                WHEN failed_login_count + 1 >= $2
                THEN now() + make_interval(secs => LEAST($4, $3 * power(2, failed_login_count + 1 - $2)))
                ELSE locked_until
            END
      WHERE id = $1
      RETURNING locked_until`,
    [userId, LOCKOUT_THRESHOLD, LOCKOUT_BASE_SECONDS, LOCKOUT_MAX_SECONDS],
  );
  return { lockedUntil: result.rows[0]?.locked_until ?? null };
}

export async function recordSuccessfulLogin(db: Queryable, userId: string): Promise<void> {
  await db.query(
    "UPDATE identity.users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [userId],
  );
}

export async function updatePasswordHash(db: Queryable, userId: string, passwordHash: string): Promise<void> {
  await db.query("UPDATE identity.users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
}

export interface DeviceInsert {
  readonly userId: string;
  readonly platform: "ios" | "android";
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
  readonly publicKeySpki: Buffer;
  readonly publicKeyAlgorithm: "ES256" | "EdDSA";
  readonly attestationType: "app_attest" | "play_integrity";
}

export async function insertTrustedDevice(db: Queryable, device: DeviceInsert): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO identity.devices (user_id, platform, device_name, app_version, os_version, public_key_spki,
                                   public_key_algorithm, attestation_type, attestation_verified_at, trusted_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())
     RETURNING id`,
    [device.userId, device.platform, device.name, device.appVersion, device.osVersion, device.publicKeySpki, device.publicKeyAlgorithm, device.attestationType],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("enregistrement de l'appareil impossible");
  return id;
}

/** Consomme un défi d'attestation encore valide ; faux s'il a déjà servi ou expiré. */
export async function consumeDeviceChallenge(db: Queryable, challengeId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE identity.device_challenges SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [challengeId],
  );
  return result.rowCount === 1;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly refreshToken: { readonly expiresAt: Date };
}

export async function createSession(
  db: Queryable,
  params: {
    readonly userId: string;
    readonly deviceId: string | null;
    readonly audience: CustomerAudience;
    readonly assuranceLevel: 1 | 2;
    readonly ipAddress: string | undefined;
    readonly userAgent: string | undefined;
    readonly refreshTokenSha256: Buffer;
  },
): Promise<CreatedSession> {
  const policy = SESSION_POLICY[params.audience];
  const session = await db.query<{ id: string; idle_expires_at: Date }>(
    `INSERT INTO identity.sessions (user_id, device_id, audience, assurance_level, mfa_verified_at, ip_address, user_agent,
                                    idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4::smallint = 2 THEN now() END, $5, $6,
             now() + make_interval(secs => $7), now() + make_interval(secs => $8))
     RETURNING id, idle_expires_at`,
    [params.userId, params.deviceId, params.audience, params.assuranceLevel, params.ipAddress ?? null, truncate(params.userAgent), policy.idleSeconds, policy.absoluteSeconds],
  );
  const row = session.rows[0];
  if (row === undefined) throw new Error("création de session impossible");
  await db.query(
    `INSERT INTO identity.refresh_tokens (session_id, family_id, token_sha256, expires_at)
     VALUES ($1, $1, $2, $3)`,
    [row.id, params.refreshTokenSha256, row.idle_expires_at],
  );
  return { sessionId: row.id, refreshToken: { expiresAt: row.idle_expires_at } };
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly session_id: string;
  readonly family_id: string;
  readonly expired: boolean;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly user_id: string;
  readonly device_id: string | null;
  readonly audience: CustomerAudience;
  readonly assurance_level: 1 | 2;
  readonly session_active: boolean;
  readonly user_status: string;
}

export async function lockRefreshToken(db: Queryable, tokenSha256: Buffer): Promise<RefreshTokenRow | undefined> {
  const result = await db.query<RefreshTokenRow>(
    `SELECT rt.id, rt.session_id, rt.family_id, rt.expires_at <= now() AS expired, rt.consumed_at, rt.revoked_at,
            s.user_id, s.device_id, s.audience, s.assurance_level,
            (s.revoked_at IS NULL AND s.absolute_expires_at > now() AND s.idle_expires_at > now()) AS session_active,
            u.status AS user_status
       FROM identity.refresh_tokens rt
       JOIN identity.sessions s ON s.id = rt.session_id
       JOIN identity.users u ON u.id = s.user_id
      WHERE rt.token_sha256 = $1
        FOR UPDATE OF rt, s`,
    [tokenSha256],
  );
  return result.rows[0];
}

/** Rotation : consomme l'ancien jeton, émet son successeur, prolonge la session. */
export async function rotateRefreshToken(
  db: Queryable,
  params: { readonly current: RefreshTokenRow; readonly newTokenSha256: Buffer },
): Promise<{ readonly expiresAt: Date }> {
  const policy = SESSION_POLICY[params.current.audience];
  await db.query("UPDATE identity.refresh_tokens SET consumed_at = now() WHERE id = $1", [params.current.id]);
  const session = await db.query<{ idle_expires_at: Date }>(
    `UPDATE identity.sessions
        SET last_used_at = now(),
            idle_expires_at = LEAST(absolute_expires_at, now() + make_interval(secs => $2))
      WHERE id = $1
      RETURNING idle_expires_at`,
    [params.current.session_id, policy.idleSeconds],
  );
  const expiresAt = session.rows[0]?.idle_expires_at;
  if (expiresAt === undefined) throw new Error("session introuvable lors de la rotation");
  await db.query(
    `INSERT INTO identity.refresh_tokens (session_id, family_id, parent_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.current.session_id, params.current.family_id, params.current.id, params.newTokenSha256, expiresAt],
  );
  return { expiresAt };
}

export async function revokeSession(db: Queryable, sessionId: string, reason: string): Promise<boolean> {
  const result = await db.query(
    "UPDATE identity.sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
    [sessionId, reason],
  );
  await db.query(
    `UPDATE identity.refresh_tokens SET revoked_at = now(), revoked_reason = $2
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return result.rowCount === 1;
}

export async function revokeUserSessions(
  db: Queryable,
  params: { readonly userId: string; readonly reason: string; readonly exceptSessionId?: string; readonly deviceId?: string },
): Promise<number> {
  const sessions = await db.query<{ id: string }>(
    `SELECT id FROM identity.sessions
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND ($3::uuid IS NULL OR device_id = $3::uuid)
        FOR UPDATE`,
    [params.userId, params.exceptSessionId ?? null, params.deviceId ?? null],
  );
  for (const session of sessions.rows) await revokeSession(db, session.id, params.reason);
  return sessions.rows.length;
}

export interface SessionSummaryRow {
  readonly id: string;
  readonly audience: CustomerAudience;
  readonly device_id: string | null;
  readonly device_name: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: Date;
  readonly last_used_at: Date;
}

export async function listActiveSessions(db: Queryable, userId: string): Promise<readonly SessionSummaryRow[]> {
  const result = await db.query<SessionSummaryRow>(
    `SELECT s.id, s.audience, s.device_id, d.device_name, host(s.ip_address) AS ip_address, s.user_agent, s.created_at, s.last_used_at
       FROM identity.sessions s
       LEFT JOIN identity.devices d ON d.id = s.device_id
      WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
      ORDER BY s.last_used_at DESC
      LIMIT 100`,
    [userId],
  );
  return result.rows;
}

export interface DeviceSummaryRow {
  readonly id: string;
  readonly platform: string;
  readonly device_name: string;
  readonly app_version: string | null;
  readonly os_version: string | null;
  readonly created_at: Date;
  readonly last_seen_at: Date | null;
}

export async function listActiveDevices(db: Queryable, userId: string): Promise<readonly DeviceSummaryRow[]> {
  const result = await db.query<DeviceSummaryRow>(
    `SELECT id, platform, device_name, app_version, os_version, created_at, last_seen_at
       FROM identity.devices WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return result.rows;
}

export async function revokeDevice(db: Queryable, userId: string, deviceId: string, reason: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE identity.devices SET revoked_at = now(), revoked_reason = $3
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId, reason],
  );
  return result.rowCount === 1;
}

export async function recordAudit(
  db: Queryable,
  event: {
    readonly actorType: "customer" | "system";
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly ipAddress?: string | undefined;
    readonly userAgent?: string | undefined;
    readonly requestId?: string | undefined;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db.query("SELECT audit.record($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", [
    event.actorType,
    event.actorId,
    event.action,
    event.targetType ?? null,
    event.targetId ?? null,
    event.ipAddress ?? null,
    truncate(event.userAgent),
    event.requestId ?? null,
    JSON.stringify(event.metadata ?? {}),
  ]);
}

function truncate(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, 512);
}
