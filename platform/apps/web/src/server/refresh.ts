import "server-only";

import { createHash } from "node:crypto";

import type { ApiTransport, ClientContext } from "./api";
import { ApiError, apiRequest } from "./api";
import type { WebSession } from "./session";

/**
 * Renouvellement des jetons. Le jeton de renouvellement est à usage unique
 * (sa réutilisation révoque la session côté API) : des requêtes simultanées
 * d'un même navigateur (préchargements, onglets) partagent donc un seul
 * renouvellement, dont le résultat est conservé 30 secondes.
 */

interface AuthenticatedResponse {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

export type RefreshOutcome = { readonly kind: "refreshed"; readonly session: WebSession } | { readonly kind: "expired" };

const inFlight = new Map<string, { readonly promise: Promise<RefreshOutcome>; readonly until: number }>();
const RESULT_TTL_MS = 30_000;

export function sessionFromAuthenticated(response: AuthenticatedResponse): WebSession {
  return {
    userId: response.userId,
    sessionId: response.sessionId,
    accessToken: response.accessToken,
    accessTokenExpiresAt: response.accessTokenExpiresAt,
    refreshToken: response.refreshToken,
    refreshTokenExpiresAt: response.refreshTokenExpiresAt,
  };
}

export function refreshSession(transport: ApiTransport, session: WebSession, context: ClientContext): Promise<RefreshOutcome> {
  const now = Date.now();
  for (const [key, entry] of inFlight) if (entry.until < now) inFlight.delete(key);
  const key = createHash("sha256").update(session.refreshToken).digest("base64url");
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing.promise;

  const promise = apiRequest<AuthenticatedResponse>(transport, {
    method: "POST",
    path: "/v1/auth/token/refresh",
    body: { refreshToken: session.refreshToken },
    context,
  }).then(
    (response): RefreshOutcome => ({ kind: "refreshed", session: sessionFromAuthenticated(response) }),
    (error: unknown): RefreshOutcome => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 400)) return { kind: "expired" };
      // Panne transitoire : on ne garde pas le résultat, un nouvel essai reste possible.
      inFlight.delete(key);
      throw error;
    },
  );
  inFlight.set(key, { promise, until: now + RESULT_TTL_MS });
  return promise;
}
