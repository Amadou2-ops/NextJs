import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AuthenticationError } from "../lib/errors.js";
import type { DeviceBindingService } from "../modules/auth/deviceBinding.service.js";
import { signedRequestParts } from "../modules/auth/deviceBinding.service.js";

/**
 * Exige, pour une session mobile, que la requête soit signée par l'appareil
 * lié à la session. Les sessions web (BFF) ne sont pas concernées : leurs
 * opérations sensibles passent par une vérification renforcée (TOTP, passkey).
 * À placer après authenticate.
 */
export function requireDeviceSignature(binding: DeviceBindingService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (auth === undefined) {
      next(new AuthenticationError());
      return;
    }
    if (auth.audience !== "mobile") {
      next();
      return;
    }
    if (auth.deviceId === null) {
      next(new AuthenticationError("Session mobile sans appareil.", { reason: "mobile_session_without_device" }));
      return;
    }
    binding
      .verify(signedRequestParts(req), { deviceId: auth.deviceId, userId: auth.subjectId })
      .then(() => {
        next();
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}
