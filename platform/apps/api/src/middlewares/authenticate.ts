import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AccessTokenVerifier, Audience } from "../auth/accessToken.js";
import type { SessionValidator } from "../auth/sessions.js";
import { AuthenticationError, ForbiddenError } from "../lib/errors.js";

/**
 * Authentification par jeton d'accès (en-tête `Authorization: Bearer`).
 *
 * L'API n'accepte AUCUN jeton par cookie : le site web et le dashboard
 * passent par leur serveur intermédiaire Next.js (BFF), qui détient le jeton
 * côté serveur et l'ajoute à l'appel. Le navigateur ne voit jamais le jeton.
 */

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._-]+)$/;

export interface AuthenticateDependencies {
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
}

export function authenticate(deps: AuthenticateDependencies, audiences: readonly Audience[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.get("authorization");
    if (header === undefined) {
      next(new AuthenticationError("Authentification requise.", { reason: "missing_authorization" }));
      return;
    }
    const match = BEARER_PATTERN.exec(header);
    const token = match?.[1];
    if (token === undefined) {
      next(new AuthenticationError("Jeton d'accès invalide.", { reason: "malformed_authorization" }));
      return;
    }

    deps.verifier
      .verify(token, audiences)
      .then(async (claims) => {
        const session = await deps.sessions.validate({
          audience: claims.audience,
          sessionId: claims.sessionId,
          subjectId: claims.subjectId,
          deviceId: claims.deviceId,
        });
        req.auth = {
          kind: claims.audience === "admin" ? "admin" : "customer",
          subjectId: claims.subjectId,
          sessionId: claims.sessionId,
          tokenId: claims.tokenId,
          audience: claims.audience,
          // Le niveau d'assurance retenu est le plus faible entre le jeton et
          // la session : une session rétrogradée prend effet immédiatement.
          assuranceLevel: Math.min(claims.assuranceLevel, session.assuranceLevel) as 1 | 2,
          deviceId: session.deviceId,
        };
        next();
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}

/** Exige une authentification à deux facteurs (niveau d'assurance 2). */
export function requireAssuranceLevel2(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.auth === undefined) {
      next(new AuthenticationError());
      return;
    }
    if (req.auth.assuranceLevel < 2) {
      next(new ForbiddenError("Une vérification en deux étapes est requise pour cette action.", { reason: "aal2_required" }));
      return;
    }
    next();
  };
}
