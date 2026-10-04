import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AdminPermission, PermissionChecker } from "../auth/permissions.js";
import { AuthenticationError, ForbiddenError } from "../lib/errors.js";

/**
 * Contrôle d'accès du personnel (RBAC). À placer après
 * authenticate(…, ["admin"]). La permission est vérifiée en base à chaque
 * requête.
 */
export function requirePermission(checker: PermissionChecker, permission: AdminPermission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (auth === undefined) {
      next(new AuthenticationError());
      return;
    }
    if (auth.kind !== "admin") {
      next(new ForbiddenError("Action réservée au personnel habilité.", { reason: "not_admin", permission }));
      return;
    }
    checker
      .hasPermission(auth.subjectId, permission)
      .then((allowed) => {
        if (!allowed) {
          next(new ForbiddenError("Vous ne disposez pas de l'habilitation requise.", { reason: "permission_denied", permission }));
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}
