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
import { startVerificationSchema, verificationIdParamsSchema } from "./kyc.schemas.js";
import type { KycService } from "./kyc.service.js";

/**
 * Routes KYC du client :
 *   GET  /v1/kyc                                   niveau, plafonds, vérifications
 *   POST /v1/kyc/verifications                     ouvre une session de capture (SDK)
 *   GET  /v1/kyc/verifications/{id}                état d'une vérification
 *   POST /v1/kyc/verifications/{id}/submitted      fin de capture signalée par l'application
 *
 * Les requêtes mutatrices d'une session mobile sont signées par l'appareil.
 * Relancer l'ouverture remplace une session non terminée (nouveau jeton SDK).
 */

export interface KycRouterDependencies {
  readonly kyc: KycService;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly deviceBinding: DeviceBindingService;
  readonly limiters: { readonly startBySubject: RateLimiterAbstract };
}

function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function kycRoutes(deps: KycRouterDependencies): Router {
  const router = Router();
  const customer = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["mobile", "web"]);
  const deviceSigned = requireDeviceSignature(deps.deviceBinding);

  router.get(
    "/v1/kyc",
    customer,
    handle(async (req, res) => {
      if (req.auth === undefined) throw new AuthenticationError();
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.kyc.overview(req.auth.subjectId));
    }),
  );

  router.post(
    "/v1/kyc/verifications",
    customer,
    deviceSigned,
    rateLimit(deps.limiters.startBySubject, bySubjectOrIp),
    validate({ body: startVerificationSchema }),
    handle(async (req, res) => {
      const auth = req.auth;
      if (auth === undefined) throw new AuthenticationError();
      const body = validatedBody(req, startVerificationSchema);
      const channel = auth.audience === "mobile" ? "mobile" : "web";
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(
        await deps.kyc.start(auth.subjectId, channel, {
          tier: body.tier,
          ...(body.declaredIdentity === undefined ? {} : { declaredIdentity: body.declaredIdentity }),
        }),
      );
    }),
  );

  router.get(
    "/v1/kyc/verifications/:verificationId",
    customer,
    validate({ params: verificationIdParamsSchema }),
    handle(async (req, res) => {
      if (req.auth === undefined) throw new AuthenticationError();
      const { verificationId } = validatedParams(req, verificationIdParamsSchema);
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.kyc.getVerification(req.auth.subjectId, verificationId));
    }),
  );

  router.post(
    "/v1/kyc/verifications/:verificationId/submitted",
    customer,
    deviceSigned,
    validate({ params: verificationIdParamsSchema }),
    handle(async (req, res) => {
      if (req.auth === undefined) throw new AuthenticationError();
      const { verificationId } = validatedParams(req, verificationIdParamsSchema);
      res.json(await deps.kyc.markSubmitted(req.auth.subjectId, verificationId));
    }),
  );

  return router;
}
