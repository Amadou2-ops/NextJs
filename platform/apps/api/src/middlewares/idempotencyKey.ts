import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AuthenticationError, ConflictError, ValidationError } from "../lib/errors.js";
import { IDEMPOTENCY_KEY_PATTERN, requestFingerprint } from "../lib/idempotency.js";
import type { IdempotencyStore } from "../lib/idempotency.js";

/**
 * Exige l'en-tête Idempotency-Key sur une route mutatrice et garantit qu'une
 * même requête n'est exécutée qu'une fois. À placer APRÈS authenticate (la
 * clé est propre à chaque client) et APRÈS validate (l'empreinte porte sur le
 * corps reçu).
 *
 * La réponse est enregistrée AVANT d'être envoyée : un client qui rejoue sa
 * requête après une coupure réseau reçoit exactement la même réponse.
 */
export function requireIdempotency(store: IdempotencyStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.get("idempotency-key");
    if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      next(
        new ValidationError(
          [{ path: "headers.idempotency-key", message: "en-tête requis : 16 à 128 caractères [A-Za-z0-9_-]" }],
          "En-tête Idempotency-Key absent ou invalide.",
        ),
      );
      return;
    }
    if (req.auth === undefined) {
      next(new AuthenticationError());
      return;
    }
    const scope = `${req.auth.kind === "admin" ? "admin" : "user"}:${req.auth.subjectId}`;
    const fingerprint = requestFingerprint(req.method, req.baseUrl + req.path, req.body);

    store
      .begin(scope, key, fingerprint)
      .then((outcome) => {
        switch (outcome.kind) {
          case "mismatch":
            next(new ConflictError("IDEMPOTENCY_CONFLICT", "Cette clé d'idempotence a déjà été utilisée pour une autre requête.", 422));
            return;
          case "in_progress":
            res.setHeader("Retry-After", "1");
            next(new ConflictError("REQUEST_IN_PROGRESS", "Une requête identique est déjà en cours de traitement."));
            return;
          case "replay":
            res.setHeader("Idempotency-Replayed", "true");
            res.status(outcome.status).json(outcome.body);
            return;
          case "started": {
            let finalized = false;
            res.locals.idempotency = {
              finalize: async (status: number, body: unknown): Promise<void> => {
                if (finalized) return;
                finalized = true;
                if (status >= 500) {
                  await store.release(scope, key);
                } else {
                  await store.complete(scope, key, status, body);
                }
              },
            };
            const originalJson = res.json.bind(res);
            res.json = (body: unknown): Response => {
              const handle = res.locals.idempotency;
              if (handle === undefined) return originalJson(body);
              delete res.locals.idempotency;
              handle
                .finalize(res.statusCode, body)
                .then(() => originalJson(body))
                .catch((error: unknown) => {
                  next(error);
                });
              return res;
            };
            next();
            return;
          }
        }
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}
