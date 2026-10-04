import "server-only";

import { createHash } from "node:crypto";

import type { ApiTransport, ClientContext } from "./api";
import { ApiError, apiRequest } from "./api";
import type { AdminSession, AdminTokens } from "./session";
import { sessionFromTokens } from "./session";

/**
 * Renouvellement des jetons du personnel. Le jeton de renouvellement est à
 * usage unique et sa réutilisation révoque la session (détection de vol) :
 * des requêtes simultanées partagent donc un seul renouvellement, dont le
 * résultat est conservé 30 secondes.
 */

export type RefreshOutcome = { readonly kind: "refreshed"; readonly session: AdminSession } | { readonly kind: "expired" };

const inFlight = new Map<string, { readonly promise: Promise<RefreshOutcome>; readonly until: number }>();
const RESULT_TTL_MS = 30_000;

export function refreshSession(transport: ApiTransport, session: AdminSession, context: ClientContext): Promise<RefreshOutcome> {
  const now = Date.now();
  for (const [key, entry] of inFlight) if (entry.until < now) inFlight.delete(key);
  const key = createHash("sha256").update(session.refreshToken).digest("base64url");
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing.promise;

  const promise = apiRequest<AdminTokens>(transport, {
    method: "POST",
    path: "/v1/admin/auth/token/refresh",
    body: { refreshToken: session.refreshToken },
    context,
  }).then(
    (tokens): RefreshOutcome => ({ kind: "refreshed", session: sessionFromTokens(tokens) }),
    (error: unknown): RefreshOutcome => {
      // 401 : session expirée, révoquée ou réseau non autorisé ; 400 : jeton malformé.
      if (error instanceof ApiError && (error.status === 401 || error.status === 400 || error.status === 403)) return { kind: "expired" };
      inFlight.delete(key);
      throw error;
    },
  );
  inFlight.set(key, { promise, until: now + RESULT_TTL_MS });
  return promise;
}
