import { randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { clientIpFrom } from "./server/api";
import { webConfig } from "./server/env";
import { refreshSession } from "./server/refresh";
import { accessTokenExpiring, sealSession, SESSION_COOKIE, unsealSession } from "./server/session";

/**
 * Proxy (exécuté avant chaque requête, environnement Node.js) :
 *
 *   1. Politique de sécurité du contenu à nonce unique par requête.
 *   2. Contrôle d'origine de TOUTE requête mutatrice (actions serveur,
 *      gestionnaires de routes) : Origin doit être l'origine du site. Next
 *      laisse passer une action sans en-tête Origin ; ici, elle est refusée.
 *   3. Renouvellement des jetons d'une session qui expire, avant le rendu
 *      (les composants serveur ne peuvent pas écrire de cookie).
 *   4. Redirection immédiate des pages de l'espace client sans session
 *      (vérification optimiste : chaque page et action revérifie).
 */

const PROTECTED_PREFIXES = ["/tableau-de-bord", "/envoyer", "/transferts", "/beneficiaires", "/verification", "/securite", "/portefeuille"];

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://sdk.onfido.com https://cdn.smileidentity.com${development ? " 'unsafe-eval'" : ""}`,
    // Stripe Elements et les SDK d'identité injectent des styles en ligne.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.stripe.com https://*.onfido.com https://*.smileidentity.com",
    "font-src 'self'",
    "connect-src 'self' https://api.stripe.com https://*.onfido.com wss://*.onfido.com https://*.smileidentity.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://*.onfido.com https://*.smileidentity.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
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
  const config = webConfig();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && request.headers.get("origin") !== config.appOrigin) {
    return forbidden();
  }

  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
      // API momentanément indisponible : la page affichera l'erreur ; la session est conservée.
    }
  }

  if (sessionCookie !== null) {
    requestHeaders.set("cookie", replaceCookie(request.headers.get("cookie"), SESSION_COOKIE, sessionCookie === "delete" ? null : sessionCookie.value));
  }

  let response: NextResponse;
  if (isProtected && session === null) {
    const login = new URL("/connexion", config.appOrigin);
    login.searchParams.set("suite", `${path}${request.nextUrl.search}`);
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
