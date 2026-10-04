import "server-only";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import type { ApiRequest, ApiTransport, ClientContext } from "./api";
import { ApiError, apiRequest, clientIpFrom } from "./api";
import { adminConfig } from "./env";
import { refreshSession } from "./refresh";
import type { AdminSession } from "./session";
import { accessTokenExpiring, expiredCookie, sealSession, SESSION_COOKIE, unsealSession } from "./session";

/**
 * Accès à l'API depuis les composants et actions serveur du back-office.
 * Composant serveur : session renouvelée en amont par le proxy ; action
 * serveur : renouvelle elle-même et efface une session refusée.
 */

export type AdminApiRequest = Omit<ApiRequest, "context" | "accessToken">;

export function transport(): ApiTransport {
  const config = adminConfig();
  return { baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs, fetch };
}

export async function clientContext(): Promise<ClientContext> {
  const incoming = await headers();
  return {
    ipAddress: clientIpFrom(incoming.get("x-forwarded-for"), adminConfig().trustedProxyHops),
    userAgent: incoming.get("user-agent"),
  };
}

export async function readSession(): Promise<AdminSession | null> {
  const store = await cookies();
  return unsealSession(adminConfig().sessionKeys, store.get(SESSION_COOKIE)?.value);
}

function loginPath(nextPath: string | null): Route {
  return nextPath === null ? "/connexion" : `/connexion?suite=${encodeURIComponent(nextPath)}`;
}

/** Appel public (authentification du personnel). */
export async function publicApi<T>(request: AdminApiRequest): Promise<T> {
  return apiRequest<T>(transport(), { ...request, context: await clientContext() });
}

export async function requireSession(nextPath: string): Promise<AdminSession> {
  const session = await readSession();
  if (session === null || accessTokenExpiring(session, new Date(), 0)) redirect(loginPath(nextPath));
  return session;
}

/**
 * Composant serveur : appel authentifié. 401 → reconnexion ; 403 (permission
 * retirée, réseau non autorisé) → page d'accès refusé ; 404 → page introuvable.
 */
export async function sessionApi<T>(nextPath: string, request: AdminApiRequest): Promise<T> {
  const session = await requireSession(nextPath);
  try {
    return await apiRequest<T>(transport(), { ...request, accessToken: session.accessToken, context: await clientContext() });
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      if (error.status === 401) redirect(loginPath(nextPath));
      if (error.status === 403) redirect("/acces-refuse");
      if (error.status === 404) notFound();
    }
    throw error;
  }
}

/** Action serveur : renouvelle si nécessaire, efface la session révoquée. */
export async function actionApi<T>(request: AdminApiRequest): Promise<T> {
  const config = adminConfig();
  const store = await cookies();
  const context = await clientContext();
  let session = await unsealSession(config.sessionKeys, store.get(SESSION_COOKIE)?.value);
  if (session === null) redirect(loginPath(null));
  if (accessTokenExpiring(session)) {
    const outcome = await refreshSession(transport(), session, context);
    if (outcome.kind === "expired") {
      clearCookie(store, SESSION_COOKIE);
      redirect(loginPath(null));
    }
    session = outcome.session;
    const cookie = await sealSession(config.sessionKeys, session);
    store.set(cookie.name, cookie.value, cookie.options);
  }
  try {
    return await apiRequest<T>(transport(), { ...request, accessToken: session.accessToken, context });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      clearCookie(store, SESSION_COOKIE);
      redirect(loginPath(null));
    }
    throw error;
  }
}

export function clearCookie(store: Awaited<ReturnType<typeof cookies>>, name: string): void {
  const cookie = expiredCookie(name);
  store.set(cookie.name, cookie.value, cookie.options);
}

export async function openSession(session: AdminSession): Promise<void> {
  const store = await cookies();
  const cookie = await sealSession(adminConfig().sessionKeys, session);
  store.set(cookie.name, cookie.value, cookie.options);
}
