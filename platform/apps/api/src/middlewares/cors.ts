import cors from "cors";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { ForbiddenError } from "../lib/errors.js";

/**
 * CORS strict : seules les origines exactes configurées (site web client,
 * dashboard d'administration) reçoivent les en-têtes CORS. Aucun joker.
 *
 * Les applications mobiles n'envoient pas d'en-tête Origin : CORS ne les
 * concerne pas. En revanche, toute requête mutatrice portant une origine non
 * autorisée est rejetée (403) : un navigateur tiers ne peut pas déclencher
 * d'opération, même si la réponse lui serait masquée (défense CSRF).
 */

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "X-Request-Id",
  "X-Device-Signature",
  "X-Device-Signature-Timestamp",
] as const;

export const CORS_EXPOSED_HEADERS = [
  "X-Request-Id",
  "Idempotency-Replayed",
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "Retry-After",
] as const;

export function strictCors(allowedOrigins: ReadonlySet<string>): RequestHandler[] {
  const corsHandler = cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });

  const rejectForeignOrigins = (req: Request, _res: Response, next: NextFunction): void => {
    const origin = req.get("origin");
    if (origin !== undefined && UNSAFE_METHODS.has(req.method) && !allowedOrigins.has(origin)) {
      next(new ForbiddenError("Origine non autorisée.", { reason: "cors_origin_rejected", origin }));
      return;
    }
    next();
  };

  return [corsHandler, rejectForeignOrigins];
}
