import type { NextFunction, Request, RequestHandler, Response } from "express";
import helmet from "helmet";

/**
 * En-têtes de sécurité d'une API JSON : aucun contenu actif n'est servi, donc
 * la politique de contenu interdit tout. Les réponses ne sont jamais mises en
 * cache (données financières personnelles).
 */
export function securityHeaders(): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: true,
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-site" },
      frameguard: { action: "deny" },
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      noSniff: true,
      referrerPolicy: { policy: "no-referrer" },
      xDnsPrefetchControl: { allow: false },
      xPermittedCrossDomainPolicies: { permittedPolicies: "none" },
    }),
    (_req: Request, res: Response, next: NextFunction): void => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
      next();
    },
  ];
}
