import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import { AuthenticationError, ValidationError } from "../../lib/errors.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../../lib/idempotency.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { bySubjectOrIp, rateLimit } from "../../middlewares/rateLimit.js";
import { requireDeviceSignature } from "../../middlewares/requireDeviceSignature.js";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middlewares/validate.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import { createTransferSchema, listTransfersQuerySchema, transferIdParamsSchema } from "./transfers.schemas.js";
import type { TransferService } from "./transfers.service.js";

/**
 * Transferts du client :
 *   POST /v1/transfers                 création (Idempotency-Key obligatoire ; mobile : signature
 *                                      de l'appareil ; web : code TOTP)
 *   GET  /v1/transfers                 liste paginée (curseur « before »)
 *   GET  /v1/transfers/{id}            détail et historique des statuts
 *   GET  /v1/transfers/{id}/funding    reprise du paiement (secret client à jour, lien hébergé)
 *   POST /v1/transfers/{id}/cancel     annulation (avant paiement au bénéficiaire)
 */
export function transferRoutes(deps: {
  readonly transfers: TransferService;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly deviceBinding: DeviceBindingService;
  readonly limiters: { readonly createBySubject: RateLimiterAbstract };
}): Router {
  const router = Router();
  const customer = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["mobile", "web"]);
  const deviceSigned = requireDeviceSignature(deps.deviceBinding);
  const handle =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
      handler(req, res).catch(next);
    };
  const auth = (req: Request): NonNullable<Request["auth"]> => {
    if (req.auth === undefined) throw new AuthenticationError();
    return req.auth;
  };

  router.post(
    "/v1/transfers",
    customer,
    deviceSigned,
    rateLimit(deps.limiters.createBySubject, bySubjectOrIp),
    validate({ body: createTransferSchema }),
    handle(async (req, res) => {
      const key = req.get("idempotency-key");
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
        throw new ValidationError([{ path: "headers.idempotency-key", message: "en-tête requis : 16 à 128 caractères [A-Za-z0-9_-]" }]);
      }
      const body = validatedBody(req, createTransferSchema);
      const result = await deps.transfers.create(auth(req), {
        quoteId: body.quoteId,
        recipientId: body.recipientId,
        purposeCode: body.purposeCode,
        idempotencyKey: key,
        totpCode: body.totpCode,
      });
      res.setHeader("Cache-Control", "no-store");
      if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
      res.status(result.replayed ? 200 : 201).json({ transfer: result.transfer, funding: result.funding });
    }),
  );

  router.get(
    "/v1/transfers",
    customer,
    validate({ query: listTransfersQuerySchema }),
    handle(async (req, res) => {
      const query = validatedQuery(req, listTransfersQuerySchema);
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.transfers.list(auth(req).subjectId, { limit: query.limit, before: query.before }));
    }),
  );

  router.get(
    "/v1/transfers/:transferId",
    customer,
    validate({ params: transferIdParamsSchema }),
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.transfers.get(auth(req).subjectId, validatedParams(req, transferIdParamsSchema).transferId));
    }),
  );

  router.get(
    "/v1/transfers/:transferId/funding",
    customer,
    validate({ params: transferIdParamsSchema }),
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.transfers.funding(auth(req).subjectId, validatedParams(req, transferIdParamsSchema).transferId));
    }),
  );

  router.post(
    "/v1/transfers/:transferId/cancel",
    customer,
    deviceSigned,
    validate({ params: transferIdParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.transfers.cancel(auth(req).subjectId, validatedParams(req, transferIdParamsSchema).transferId));
    }),
  );

  return router;
}
