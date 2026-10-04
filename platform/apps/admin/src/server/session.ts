import "server-only";

import type { Route } from "next";
import { decodeJwt } from "jose";
import { z } from "zod";

import { seal, unseal } from "./sealing";

/**
 * Session du back-office. Les jetons du personnel (accès 10 min, audience
 * admin ; renouvellement à usage unique) restent côté serveur : le navigateur
 * ne détient qu'un cookie chiffré __Host-, HttpOnly, Secure, SameSite=Strict,
 * qui expire avec la session absolue décidée par l'API.
 */

export const SESSION_COOKIE = "__Host-tpa_session";
export const PENDING_COOKIE = "__Host-tpa_pending";

export const sessionSchema = z.object({
  adminId: z.uuid(),
  sessionId: z.uuid(),
  accessToken: z.string().min(20).max(4096),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string().regex(/^art_[A-Za-z0-9_-]{43}$/),
  sessionExpiresAt: z.iso.datetime({ offset: true }),
});
export type AdminSession = z.infer<typeof sessionSchema>;

/** Défi WebAuthn en cours (connexion ou enrôlement), 5 minutes comme côté API. */
export const pendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("login"),
    challengeId: z.uuid(),
    next: z
      .string()
      .max(200)
      .nullable()
      .transform((value) => safeNextPath(value)),
  }),
  z.object({ kind: z.literal("enrollment"), challengeId: z.uuid() }),
]);
export type PendingStep = z.infer<typeof pendingSchema>;

export interface CookieWrite {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly httpOnly: true;
    readonly secure: true;
    readonly sameSite: "strict";
    readonly path: "/";
    readonly expires: Date;
  };
}

function cookieOptions(expires: Date): CookieWrite["options"] {
  return { httpOnly: true, secure: true, sameSite: "strict", path: "/", expires };
}

/** Jetons renvoyés par l'API (connexion, renouvellement). */
export interface AdminTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly sessionExpiresAt: string;
}

/**
 * Session à partir des jetons reçus directement de l'API (canal de confiance) :
 * le membre et la session sont lus dans le jeton d'accès (sub, sid), dont
 * l'API revérifie la signature à chaque appel.
 */
export function sessionFromTokens(tokens: AdminTokens): AdminSession {
  const claims = decodeJwt(tokens.accessToken);
  return sessionSchema.parse({
    adminId: claims.sub,
    sessionId: claims["sid"],
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    sessionExpiresAt: tokens.sessionExpiresAt,
  });
}

export async function sealSession(keys: readonly Buffer[], session: AdminSession): Promise<CookieWrite> {
  const expires = new Date(session.sessionExpiresAt);
  return { name: SESSION_COOKIE, value: await seal(keys, "admin-session", session, expires), options: cookieOptions(expires) };
}

export function unsealSession(keys: readonly Buffer[], value: string | undefined): Promise<AdminSession | null> {
  return value === undefined ? Promise.resolve(null) : unseal(keys, "admin-session", value, sessionSchema);
}

export async function sealPending(keys: readonly Buffer[], step: PendingStep, ttlSeconds = 300): Promise<CookieWrite> {
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  return { name: PENDING_COOKIE, value: await seal(keys, "admin-pending", step, expires), options: cookieOptions(expires) };
}

export function unsealPending(keys: readonly Buffer[], value: string | undefined): Promise<PendingStep | null> {
  return value === undefined ? Promise.resolve(null) : unseal(keys, "admin-pending", value, pendingSchema);
}

/** Effacement d'un cookie __Host- : mêmes attributs qu'à la création. */
export function expiredCookie(name: string): CookieWrite {
  return { name, value: "", options: cookieOptions(new Date(0)) };
}

export function accessTokenExpiring(session: AdminSession, now: Date = new Date(), marginSeconds = 60): boolean {
  return new Date(session.accessTokenExpiresAt).getTime() - now.getTime() < marginSeconds * 1000;
}

/** Retour après connexion : chemin interne du back-office uniquement. */
export function safeNextPath(value: string | null | undefined): Route | null {
  if (value === null || value === undefined) return null;
  if (!/^\/(?!\/)[A-Za-z0-9\-._~/?=&%]{0,199}$/.test(value) || value.includes("\\") || value.startsWith("/api/") || value.startsWith("/connexion") || value.startsWith("/enrolement")) return null;
  return value as Route;
}
