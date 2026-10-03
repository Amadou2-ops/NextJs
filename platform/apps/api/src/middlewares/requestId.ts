import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

/**
 * Identifiant de corrélation. Un identifiant fourni par l'appelant (BFF,
 * répartiteur de charge) n'est repris que s'il est bien formé : un en-tête
 * arbitraire ne doit jamais polluer les journaux.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  };
}
