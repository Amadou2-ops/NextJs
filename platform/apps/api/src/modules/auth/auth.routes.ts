import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import { authenticate, requireAssuranceLevel2 } from "../../middlewares/authenticate.js";
import { byClientIp, rateLimit } from "../../middlewares/rateLimit.js";
import type { RateLimitKey } from "../../middlewares/rateLimit.js";
import { requireDeviceSignature } from "../../middlewares/requireDeviceSignature.js";
import { validate } from "../../middlewares/validate.js";
import type { AuthController } from "./auth.controller.js";
import {
  accountClosureSchema,
  deviceIdParamsSchema,
  loginCompleteSchema,
  loginStartSchema,
  passkeyAuthenticationVerifySchema,
  passkeyRegistrationVerifySchema,
  passwordResetCompleteSchema,
  passwordResetStartSchema,
  refreshSchema,
  registrationCompleteSchema,
  registrationStartSchema,
  sessionIdParamsSchema,
  totpCodeSchema,
} from "./auth.schemas.js";
import type { DeviceBindingService } from "./deviceBinding.service.js";

/**
 * Routes /v1/auth. Limitations de débit spécifiques :
 *   - par IP sur toutes les routes publiques (bourrage d'identifiants) ;
 *   - par numéro de téléphone sur l'inscription, la connexion et la
 *     réinitialisation du mot de passe (attaque
 *     ciblée d'un compte, « SMS pumping »).
 */

export interface AuthRateLimiters {
  /** Routes publiques, par IP. */
  readonly publicByIp: RateLimiterAbstract;
  /** Inscription / connexion, par numéro de téléphone. */
  readonly byPhone: RateLimiterAbstract;
}

export interface AuthRouterDependencies {
  readonly controller: AuthController;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly deviceBinding: DeviceBindingService;
  readonly limiters: AuthRateLimiters;
}

const byPhoneInBody: RateLimitKey = (req) => {
  const body = req.body as { phone?: unknown } | undefined;
  if (typeof body?.phone !== "string") return byClientIp(req);
  const digits = body.phone.replace(/\D/g, "").slice(-12);
  return digits.length === 0 ? byClientIp(req) : `phone:${digits}`;
};

/** Adapte un contrôleur asynchrone (Express 5 propage les rejets). */
function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function authRoutes(deps: AuthRouterDependencies): Router {
  const router = Router();
  const c = deps.controller;
  const publicLimit = rateLimit(deps.limiters.publicByIp, byClientIp);
  const phoneLimit = rateLimit(deps.limiters.byPhone, byPhoneInBody);
  const customer = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["mobile", "web"]);
  const webOnly = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["web"]);
  const deviceSigned = requireDeviceSignature(deps.deviceBinding);
  const aal2 = requireAssuranceLevel2();

  // Public
  router.post("/v1/auth/device-challenges", publicLimit, handle(c.createDeviceChallenge));
  router.post("/v1/auth/registration/start", publicLimit, phoneLimit, validate({ body: registrationStartSchema }), handle(c.startRegistration));
  router.post("/v1/auth/registration/complete", publicLimit, phoneLimit, validate({ body: registrationCompleteSchema }), handle(c.completeRegistration));
  router.post("/v1/auth/login", publicLimit, phoneLimit, validate({ body: loginStartSchema }), handle(c.startLogin));
  router.post("/v1/auth/login/verify", publicLimit, validate({ body: loginCompleteSchema }), handle(c.completeLogin));
  router.post("/v1/auth/password-reset/start", publicLimit, phoneLimit, validate({ body: passwordResetStartSchema }), handle(c.startPasswordReset));
  router.post("/v1/auth/password-reset/complete", publicLimit, phoneLimit, validate({ body: passwordResetCompleteSchema }), handle(c.completePasswordReset));
  router.post("/v1/auth/token/refresh", publicLimit, validate({ body: refreshSchema }), handle(c.refresh));
  router.post("/v1/auth/passkeys/authentication/options", publicLimit, handle(c.passkeyAuthenticationOptions));
  router.post("/v1/auth/passkeys/authentication/verify", publicLimit, validate({ body: passkeyAuthenticationVerifySchema }), handle(c.passkeyAuthenticationVerify));

  // Authentifié
  router.post("/v1/auth/logout", customer, deviceSigned, handle(c.logout));
  router.get("/v1/auth/sessions", customer, handle(c.listSessions));
  router.delete("/v1/auth/sessions/:sessionId", customer, deviceSigned, aal2, validate({ params: sessionIdParamsSchema }), handle(c.revokeSession));
  router.post("/v1/auth/sessions/revoke-others", customer, deviceSigned, aal2, handle(c.revokeOtherSessions));
  router.post("/v1/auth/account/close", customer, deviceSigned, aal2, validate({ body: accountClosureSchema }), handle(c.closeAccount));
  router.get("/v1/auth/devices", customer, handle(c.listDevices));
  router.delete("/v1/auth/devices/:deviceId", customer, deviceSigned, aal2, validate({ params: deviceIdParamsSchema }), handle(c.revokeDevice));
  router.post("/v1/auth/mfa/totp/setup", customer, deviceSigned, aal2, handle(c.startTotpEnrollment));
  router.post("/v1/auth/mfa/totp/confirm", customer, deviceSigned, aal2, validate({ body: totpCodeSchema }), handle(c.confirmTotpEnrollment));
  router.post("/v1/auth/mfa/totp/disable", customer, deviceSigned, aal2, validate({ body: totpCodeSchema }), handle(c.disableTotp));
  router.post("/v1/auth/passkeys/registration/options", webOnly, aal2, handle(c.passkeyRegistrationOptions));
  router.post("/v1/auth/passkeys/registration/verify", webOnly, aal2, validate({ body: passkeyRegistrationVerifySchema }), handle(c.passkeyRegistrationVerify));

  return router;
}
