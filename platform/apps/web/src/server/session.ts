import "server-only";

import type { Route } from "next";
import { z } from "zod";

import { seal, unseal } from "./sealing";

/**
 * Session du site client. Les jetons de l'API (accès 10 min, renouvellement
 * à usage unique) ne quittent jamais le serveur : le navigateur ne détient
 * qu'un cookie chiffré, HttpOnly, Secure, SameSite=Strict, préfixé __Host-
 * (lié à l'origine exacte, sans attribut Domain).
 */

export const SESSION_COOKIE = "__Host-tp_session";
export const PENDING_COOKIE = "__Host-tp_pending";

export const sessionSchema = z.object({
  userId: z.uuid(),
  sessionId: z.uuid(),
  accessToken: z.string().min(20).max(2048),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string().min(10).max(128),
  refreshTokenExpiresAt: z.iso.datetime({ offset: true }),
});
export type WebSession = z.infer<typeof sessionSchema>;

/** Étape d'authentification en cours (défi SMS / TOTP, inscription, réinitialisation), 10 minutes au plus. */
export const pendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("login"),
    loginChallengeId: z.uuid(),
    method: z.enum(["sms_otp", "totp"]),
    next: z
      .string()
      .max(200)
      .nullable()
      .transform((value) => safeNextPath(value)),
  }),
  z.object({
    kind: z.literal("registration"),
    challengeId: z.uuid(),
    phone: z.string().min(6).max(32),
    countryOfResidence: z.string().regex(/^[A-Z]{2}$/),
  }),
  z.object({
    kind: z.literal("password_reset"),
    challengeId: z.uuid(),
    phone: z.string().min(6).max(32),
    countryHint: z.string().regex(/^[A-Z]{2}$/),
  }),
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

export async function sealSession(keys: readonly Buffer[], session: WebSession): Promise<CookieWrite> {
  const expires = new Date(session.refreshTokenExpiresAt);
  return { name: SESSION_COOKIE, value: await seal(keys, "session", session, expires), options: cookieOptions(expires) };
}

export function unsealSession(keys: readonly Buffer[], value: string | undefined): Promise<WebSession | null> {
  return value === undefined ? Promise.resolve(null) : unseal(keys, "session", value, sessionSchema);
}

export async function sealPending(keys: readonly Buffer[], step: PendingStep, ttlSeconds = 600): Promise<CookieWrite> {
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  return { name: PENDING_COOKIE, value: await seal(keys, "pending", step, expires), options: cookieOptions(expires) };
}

export function unsealPending(keys: readonly Buffer[], value: string | undefined): Promise<PendingStep | null> {
  return value === undefined ? Promise.resolve(null) : unseal(keys, "pending", value, pendingSchema);
}

/**
 * Suppression d'un cookie __Host- : le navigateur n'accepte l'effacement
 * qu'avec les mêmes attributs (Secure, Path=/, sans Domain).
 */
export function expiredCookie(name: string): CookieWrite {
  return { name, value: "", options: cookieOptions(new Date(0)) };
}

/** Le jeton d'accès expire-t-il dans moins de `marginSeconds` ? */
export function accessTokenExpiring(session: WebSession, now: Date = new Date(), marginSeconds = 60): boolean {
  return new Date(session.accessTokenExpiresAt).getTime() - now.getTime() < marginSeconds * 1000;
}

/**
 * Cible de redirection après connexion : chemin interne uniquement (pas de
 * redirection ouverte). Une fois validé, le chemin est typé comme route du site.
 */
export function safeNextPath(value: string | null | undefined): Route | null {
  if (value === null || value === undefined) return null;
  if (!/^\/(?!\/)[A-Za-z0-9\-._~/?=&%]{0,199}$/.test(value) || value.includes("\\") || value.startsWith("/api/")) return null;
  return value as Route;
}
