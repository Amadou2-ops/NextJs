import type { AuthContext } from "../auth/authContext.js";
import type { IdempotencyHandle } from "../lib/idempotency.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- extension officielle des types Express
  namespace Express {
    interface Request {
      /** Identifiant de corrélation (en-tête X-Request-Id). */
      requestId: string;
      /** Identité authentifiée (après le middleware authenticate). */
      auth?: AuthContext;
      /** Données validées par le middleware validate. */
      validated?: {
        readonly body?: unknown;
        readonly query?: unknown;
        readonly params?: unknown;
      };
    }
    interface Locals {
      /** Requête idempotente en cours (middleware requireIdempotency). */
      idempotency?: IdempotencyHandle;
    }
  }
}

export {};
