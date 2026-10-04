import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { AdminPermission } from "../../auth/permissions.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { DatabasePool } from "../../db/pool.js";
import type { Actor, Queryable } from "../../db/transaction.js";
import { AuthenticationError, ForbiddenError } from "../../lib/errors.js";
import { authenticate } from "../../middlewares/authenticate.js";

/**
 * Contrôle d'accès du back-office, appliqué à chaque requête :
 *   1. jeton d'accès du personnel (audience admin, clés distinctes) ;
 *   2. session active en base (révocation immédiate) ;
 *   3. adresse IP dans les plages autorisées du membre (VPN d'entreprise) ;
 *   4. permission RBAC lue en base (un retrait de rôle prend effet
 *      immédiatement).
 * Les vérifications 3 et 4 sont faites en une requête.
 */

export interface AdminAccessDependencies {
  readonly pool: DatabasePool;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
}

export interface AdminRequestContext {
  readonly adminId: string;
  readonly sessionId: string;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly requestId: string;
}

/**
 * Adresse cliente normalisée : une adresse IPv4 vue au travers d'une
 * socket IPv6 (::ffff:a.b.c.d) est ramenée à sa forme IPv4, seule
 * comparable aux plages IPv4 autorisées.
 */
export function clientIpOf(req: Request): string | undefined {
  const ip = req.ip;
  if (ip === undefined) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped?.[1] ?? ip;
}

export function adminActor(context: AdminRequestContext): Actor {
  return { type: "admin", id: context.adminId };
}

export function adminContextOf(req: Request): AdminRequestContext {
  const auth = req.auth;
  if (auth?.kind !== "admin") throw new AuthenticationError();
  return { adminId: auth.subjectId, sessionId: auth.sessionId, ipAddress: clientIpOf(req), userAgent: req.get("user-agent"), requestId: req.requestId };
}

/** Garde réseau + permission (null : tout membre actif authentifié). */
function requireNetworkAndPermission(pool: DatabasePool, permission: AdminPermission | null): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (auth?.kind !== "admin") {
      next(new AuthenticationError());
      return;
    }
    pool
      .query<{ network_allowed: boolean; permitted: boolean }>(
        `SELECT COALESCE($2::inet <<= ANY (u.allowed_ip_ranges), false) AS network_allowed,
                ($3::text IS NULL OR backoffice.has_permission(u.id, $3::text)) AS permitted
           FROM backoffice.admin_users u
          WHERE u.id = $1 AND u.status = 'active'`,
        [auth.subjectId, clientIpOf(req) ?? null, permission],
      )
      .then((result) => {
        const row = result.rows[0];
        if (row === undefined) {
          next(new AuthenticationError("Session expirée ou révoquée.", { reason: "admin_inactive" }));
          return;
        }
        if (!row.network_allowed) {
          next(new ForbiddenError("Accès au back-office refusé depuis ce réseau.", { reason: "network_denied" }));
          return;
        }
        if (!row.permitted) {
          next(new ForbiddenError("Vous ne disposez pas de l'habilitation requise.", { reason: "permission_denied", permission }));
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}

export function adminAccess(deps: AdminAccessDependencies): (permission: AdminPermission | null) => RequestHandler[] {
  const authenticated = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["admin"]);
  // Déjà authentifié par la garde de préfixe : la vérification n'est pas refaite.
  const ensureAuthenticated: RequestHandler = (req, res, next) => {
    if (req.auth?.kind === "admin") {
      next();
      return;
    }
    authenticated(req, res, next);
  };
  return (permission) => [ensureAuthenticated, requireNetworkAndPermission(deps.pool, permission)];
}

/**
 * Garde de préfixe : toute route /v1/admin/* (hors authentification du
 * personnel) exige un jeton admin et un réseau autorisé, y compris les routes
 * montées par d'autres modules (registre).
 */
export function adminPrefixGuard(deps: AdminAccessDependencies): RequestHandler {
  const [ensureAuthenticated, network] = adminAccess(deps)(null);
  return (req, res, next) => {
    if (!req.path.startsWith("/v1/admin/") || req.path.startsWith("/v1/admin/auth/")) {
      next();
      return;
    }
    ensureAuthenticated?.(req, res, (error?: unknown) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      network?.(req, res, next);
    });
  };
}

/** Événement du journal d'audit chaîné au nom d'un membre du personnel. */
export async function recordAdminAudit(
  db: Queryable,
  context: AdminRequestContext,
  event: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db.query("SELECT audit.record('admin', $1, $2, $3, $4, $5, $6, $7, $8::jsonb)", [
    context.adminId,
    event.action,
    event.targetType,
    event.targetId,
    context.ipAddress ?? null,
    context.userAgent === undefined ? null : context.userAgent.slice(0, 512),
    context.requestId,
    JSON.stringify({ session_id: context.sessionId, ...(event.metadata ?? {}) }),
  ]);
}

/** Événement d'audit hors session (connexion, enrôlement). */
export async function recordSystemAudit(
  db: Queryable,
  event: {
    readonly actorType: "admin" | "system";
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly ipAddress: string | undefined;
    readonly userAgent: string | undefined;
    readonly requestId: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db.query("SELECT audit.record($1::audit.actor_type, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", [
    event.actorType,
    event.actorId,
    event.action,
    event.targetType,
    event.targetId,
    event.ipAddress ?? null,
    event.userAgent === undefined ? null : event.userAgent.slice(0, 512),
    event.requestId,
    JSON.stringify(event.metadata ?? {}),
  ]);
}
