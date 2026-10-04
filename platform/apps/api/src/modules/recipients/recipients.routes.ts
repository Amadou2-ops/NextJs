import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import { AuthenticationError } from "../../lib/errors.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { bySubjectOrIp, rateLimit } from "../../middlewares/rateLimit.js";
import { requireDeviceSignature } from "../../middlewares/requireDeviceSignature.js";
import { validate, validatedBody, validatedParams } from "../../middlewares/validate.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import { createRecipientSchema, recipientIdParamsSchema } from "./recipients.schemas.js";
import type { RecipientService } from "./recipients.service.js";

/**
 * Bénéficiaires du client :
 *   GET    /v1/recipients
 *   POST   /v1/recipients               (session mobile : requête signée par l'appareil)
 *   DELETE /v1/recipients/{id}          archivage (l'historique des transferts reste intact)
 */
export function recipientRoutes(deps: {
  readonly recipients: RecipientService;
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
  const subject = (req: Request): string => {
    if (req.auth === undefined) throw new AuthenticationError();
    return req.auth.subjectId;
  };

  router.get(
    "/v1/recipients",
    customer,
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ recipients: await deps.recipients.list(subject(req)) });
    }),
  );

  router.post(
    "/v1/recipients",
    customer,
    deviceSigned,
    rateLimit(deps.limiters.createBySubject, bySubjectOrIp),
    validate({ body: createRecipientSchema }),
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(await deps.recipients.create(subject(req), validatedBody(req, createRecipientSchema)));
    }),
  );

  router.delete(
    "/v1/recipients/:recipientId",
    customer,
    deviceSigned,
    validate({ params: recipientIdParamsSchema }),
    handle(async (req, res) => {
      await deps.recipients.archive(subject(req), validatedParams(req, recipientIdParamsSchema).recipientId);
      res.status(204).end();
    }),
  );

  return router;
}
