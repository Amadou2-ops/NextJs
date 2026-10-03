import type { DatabasePool } from "../db/pool.js";
import { AuthenticationError } from "../lib/errors.js";
import type { Audience } from "./accessToken.js";

/**
 * Vérification de la session portée par le jeton (claim `sid`). Un jeton
 * cryptographiquement valide n'est accepté que si sa session est active en
 * base : la révocation (déconnexion, vol de jeton détecté, suspension du
 * compte) prend effet immédiatement, sans attendre l'expiration du jeton.
 */

export interface ActiveSession {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly assuranceLevel: 1 | 2;
  readonly deviceId: string | null;
}

export interface SessionValidator {
  validate(params: {
    readonly audience: Audience;
    readonly sessionId: string;
    readonly subjectId: string;
    readonly deviceId: string | undefined;
  }): Promise<ActiveSession>;
}

interface CustomerSessionRow {
  id: string;
  user_id: string;
  assurance_level: number;
  device_id: string | null;
}

interface AdminSessionRow {
  id: string;
  admin_user_id: string;
}

export class PostgresSessionValidator implements SessionValidator {
  constructor(private readonly pool: DatabasePool) {}

  async validate(params: {
    readonly audience: Audience;
    readonly sessionId: string;
    readonly subjectId: string;
    readonly deviceId: string | undefined;
  }): Promise<ActiveSession> {
    if (params.audience === "admin") {
      const result = await this.pool.query<AdminSessionRow>(
        `SELECT s.id, s.admin_user_id
           FROM backoffice.sessions s
           JOIN backoffice.admin_users u ON u.id = s.admin_user_id
          WHERE s.id = $1
            AND s.admin_user_id = $2
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > now()
            AND s.absolute_expires_at > now()
            AND u.status = 'active'`,
        [params.sessionId, params.subjectId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new AuthenticationError("Session expirée ou révoquée.", { reason: "admin_session_inactive" });
      // Le personnel est toujours authentifié par clé matérielle WebAuthn.
      return { sessionId: row.id, subjectId: row.admin_user_id, assuranceLevel: 2, deviceId: null };
    }

    const result = await this.pool.query<CustomerSessionRow>(
      `SELECT s.id, s.user_id, s.assurance_level, s.device_id
         FROM identity.sessions s
         JOIN identity.users u ON u.id = s.user_id
         LEFT JOIN identity.devices d ON d.id = s.device_id
        WHERE s.id = $1
          AND s.user_id = $2
          AND s.audience = $3::identity.session_audience
          AND s.revoked_at IS NULL
          AND s.idle_expires_at > now()
          AND s.absolute_expires_at > now()
          AND u.status IN ('active', 'pending_verification')
          AND (s.device_id IS NULL OR d.revoked_at IS NULL)`,
      [params.sessionId, params.subjectId, params.audience],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthenticationError("Session expirée ou révoquée.", { reason: "session_inactive" });
    if (params.audience === "mobile" && row.device_id !== params.deviceId) {
      throw new AuthenticationError("Session expirée ou révoquée.", { reason: "device_mismatch" });
    }
    if (row.assurance_level !== 1 && row.assurance_level !== 2) {
      throw new AuthenticationError("Session expirée ou révoquée.", { reason: "invalid_assurance_level" });
    }
    return {
      sessionId: row.id,
      subjectId: row.user_id,
      assuranceLevel: row.assurance_level,
      deviceId: row.device_id,
    };
  }
}
