import { randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { clientIpFrom } from "./server/api";
import { adminConfig } from "./server/env";
import { refreshSession } from "./server/refresh";
import { accessTokenExpiring, sealSession, SESSION_COOKIE, unsealSession } from "./server/session";

/**
 * Proxy du back-office (avant chaque requête, environnement Node.js) :
 *
 *   1. CSP stricte à nonce par requête : aucun script ni style tiers, aucun
 *      style en ligne en production.
 *   2. Contrôle d'origine de toute requête mutatrice (403 sinon).
 *   3. Renouvellement des jetons avant expiration (le jeton de renouvellement
 *      est à usage unique, la session d'inactivité est prolongée par l'API).
 *   4. Toute page hors connexion/enrôlement exige une session.
 */

const PUBLIC_PREFIXES = ["/connexion", "/enrolement"];

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${development ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function forbidden(): NextResponse {
  return new NextResponse(JSON.stringify({ title: "Origine refusée", status: 403 }), {
    status: 403,
    headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store" },
  });
}

function replaceCookie(header: string | null, name: string, value: string | null): string {
  const kept = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${name}=`));
  if (value !== null) kept.push(`${name}=${value}`);
  return kept.join("; ");
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const config = adminConfig();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== config.appOrigin) {
    return forbidden();
  }

  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const sealed = request.cookies.get(SESSION_COOKIE)?.value;
  let session = await unsealSession(config.sessionKeys, sealed);
  let sessionCookie: { readonly value: string; readonly expires: Date } | "delete" | null = null;

  if (sealed !== undefined && session === null) sessionCookie = "delete";
  if (session !== null && accessTokenExpiring(session)) {
    try {
      const outcome = await refreshSession(
        { baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs, fetch },
        session,
        { ipAddress: clientIpFrom(request.headers.get("x-forwarded-for"), config.trustedProxyHops), userAgent: request.headers.get("user-agent") },
      );
      if (outcome.kind === "refreshed") {
        session = outcome.session;
        const cookie = await sealSession(config.sessionKeys, session);
        sessionCookie = { value: cookie.value, expires: cookie.options.expires };
      } else {
        session = null;
        sessionCookie = "delete";
      }
    } catch {
      // API indisponible : la page affichera l'erreur ; la session est conservée.
    }
  }

  if (sessionCookie !== null) {
    requestHeaders.set("cookie", replaceCookie(request.headers.get("cookie"), SESSION_COOKIE, sessionCookie === "delete" ? null : sessionCookie.value));
  }

  let response: NextResponse;
  if (!isPublic && session === null) {
    const login = new URL("/connexion", config.appOrigin);
    if (path !== "/") login.searchParams.set("suite", `${path}${request.nextUrl.search}`);
    response = NextResponse.redirect(login, 303);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (sessionCookie === "delete") {
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", expires: new Date(0) });
  } else if (sessionCookie !== null) {
    response.cookies.set(SESSION_COOKIE, sessionCookie.value, { httpOnly: true, secure: true, sameSite: "strict", path: "/", expires: sessionCookie.expires });
  }
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
