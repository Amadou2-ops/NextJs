import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AppError } from "../lib/errors.js";

/**
 * Corps de requête : JSON UTF-8 uniquement, taille bornée, mode strict
 * (objets et tableaux seulement). Une requête mutatrice avec un corps d'un
 * autre type est refusée (415) au lieu d'être ignorée silencieusement.
 */
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

export function jsonBody(limitBytes = 64 * 1024): RequestHandler[] {
  const requireJson = (req: Request, _res: Response, next: NextFunction): void => {
    const hasBody = req.get("transfer-encoding") !== undefined || Number(req.get("content-length") ?? "0") > 0;
    if (BODY_METHODS.has(req.method) && hasBody && !req.is("application/json")) {
      next(
        new AppError("UNSUPPORTED_MEDIA_TYPE", 415, "Type de contenu non supporté", {
          detail: "Le corps de la requête doit être de type application/json.",
        }),
      );
      return;
    }
    next();
  };
  return [requireJson, express.json({ limit: limitBytes, strict: true, type: "application/json" })];
}
