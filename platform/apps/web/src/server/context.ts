import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import type { ApiRequest, ApiTransport, ClientContext } from "./api";
import { ApiError, apiRequest, clientIpFrom } from "./api";
import { webConfig } from "./env";
import { refreshSession } from "./refresh";
import type { WebSession } from "./session";
import { accessTokenExpiring, expiredCookie, sealSession, SESSION_COOKIE, unsealSession } from "./session";

/**
 * Accès à l'API depuis les composants serveur et les actions serveur.
 *
 * - Composant serveur : lit la session (renouvelée en amont par le proxy) ;
 *   sans session valide, redirection vers la connexion.
 * - Action serveur : peut écrire les cookies, donc renouvelle elle-même un
 *   jeton qui expire et efface la session refusée par l'API.
 */

export function transport(): ApiTransport {
  const config = webConfig();
  return { baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs, fetch };
}

export async function clientContext(): Promise<ClientContext> {
  const incoming = await headers();
  return {
    ipAddress: clientIpFrom(incoming.get("x-forwarded-for"), webConfig().trustedProxyHops),
    userAgent: incoming.get("user-agent"),
  };
}

export async function readSession(): Promise<WebSession | null> {
  const store = await cookies();
  return unsealSession(webConfig().sessionKeys, store.get(SESSION_COOKIE)?.value);
}

/** Appel public (sans session). */
export async function publicApi<T>(request: Omit<ApiRequest, "context" | "accessToken">): Promise<T> {
  return apiRequest<T>(transport(), { ...request, context: await clientContext() });
}

/** Composant serveur : session exigée, sinon redirection vers la connexion. */
export async function requireSession(nextPath: string): Promise<WebSession> {
  const session = await readSession();
  if (session === null || accessTokenExpiring(session, new Date(), 0)) {
    redirect(`/connexion?suite=${encodeURIComponent(nextPath)}`);
  }
  return session;
}

/** Composant serveur : appel authentifié (401 → reconnexion). */
export async function sessionApi<T>(nextPath: string, request: Omit<ApiRequest, "context" | "accessToken">): Promise<T> {
  const session = await requireSession(nextPath);
  try {
    return await apiRequest<T>(transport(), { ...request, accessToken: session.accessToken, context: await clientContext() });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) redirect(`/connexion?suite=${encodeURIComponent(nextPath)}`);
    throw error;
  }
}

/** Action serveur : renouvelle si nécessaire, efface la session révoquée. */
export async function actionApi<T>(request: Omit<ApiRequest, "context" | "accessToken">): Promise<T> {
  const config = webConfig();
  const store = await cookies();
  const context = await clientContext();
  let session = await unsealSession(config.sessionKeys, store.get(SESSION_COOKIE)?.value);
  if (session === null) redirect("/connexion");
  if (accessTokenExpiring(session)) {
    const outcome = await refreshSession(transport(), session, context);
    if (outcome.kind === "expired") {
      clearCookie(store, SESSION_COOKIE);
      redirect("/connexion");
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
      redirect("/connexion");
    }
    throw error;
  }
}

/** Efface un cookie de session ou d'étape (mêmes attributs qu'à sa création). */
export function clearCookie(store: Awaited<ReturnType<typeof cookies>>, name: string): void {
  const cookie = expiredCookie(name);
  store.set(cookie.name, cookie.value, cookie.options);
}

/** Ouvre la session du navigateur après une authentification réussie. */
export async function openSession(session: WebSession): Promise<void> {
  const store = await cookies();
  const cookie = await sealSession(webConfig().sessionKeys, session);
  store.set(cookie.name, cookie.value, cookie.options);
}
