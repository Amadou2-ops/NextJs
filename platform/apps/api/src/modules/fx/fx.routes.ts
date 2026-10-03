import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import { AuthenticationError } from "../../lib/errors.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { byClientIp, bySubjectOrIp, rateLimit } from "../../middlewares/rateLimit.js";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middlewares/validate.js";
import { createQuoteSchema, estimateQuerySchema, quoteIdParamsSchema } from "./fx.schemas.js";
import type { QuoteService } from "./quote.service.js";

/**
 * Routes de change :
 *   GET  /v1/fx/estimate      simulation publique (calculateur du site web) ;
 *   POST /v1/quotes           devis garanti pour le client connecté ;
 *   GET  /v1/quotes/{id}      consultation d'un devis du client.
 */

export interface FxRouterDependencies {
  readonly quotes: QuoteService;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly limiters: { readonly estimateByIp: RateLimiterAbstract; readonly quotesBySubject: RateLimiterAbstract };
}

function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function fxRoutes(deps: FxRouterDependencies): Router {
  const router = Router();
  const customer = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["mobile", "web"]);

  router.get(
    "/v1/fx/estimate",
    rateLimit(deps.limiters.estimateByIp, byClientIp),
    validate({ query: estimateQuerySchema }),
    handle(async (req, res) => {
      const query = validatedQuery(req, estimateQuerySchema);
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.quotes.estimate(query));
    }),
  );

  router.post(
    "/v1/quotes",
    customer,
    rateLimit(deps.limiters.quotesBySubject, bySubjectOrIp),
    validate({ body: createQuoteSchema }),
    handle(async (req, res) => {
      if (req.auth === undefined) throw new AuthenticationError();
      const body = validatedBody(req, createQuoteSchema);
      res.status(201).json(await deps.quotes.createQuote(req.auth.subjectId, body));
    }),
  );

  router.get(
    "/v1/quotes/:quoteId",
    customer,
    validate({ params: quoteIdParamsSchema }),
    handle(async (req, res) => {
      if (req.auth === undefined) throw new AuthenticationError();
      const { quoteId } = validatedParams(req, quoteIdParamsSchema);
      res.json(await deps.quotes.getQuote(req.auth.subjectId, quoteId));
    }),
  );

  return router;
}
