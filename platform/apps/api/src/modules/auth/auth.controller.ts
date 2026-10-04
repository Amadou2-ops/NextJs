import type { Request, Response } from "express";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { AuthenticationError } from "../../lib/errors.js";
import type { AuthContext } from "../../auth/authContext.js";
import { validatedBody, validatedParams } from "../../middlewares/validate.js";
import {
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
import type { AuthenticatedResult, AuthService, RequestContext, SecondFactorRequired } from "./auth.service.js";
import { signedRequestParts } from "./deviceBinding.service.js";
import type { MfaService } from "./mfa.service.js";
import type { PasskeyService } from "./passkey.service.js";

/**
 * Contrôleurs HTTP du module d'authentification : traduction requête →
 * service → réponse. Aucune règle métier ici.
 */

function contextOf(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.get("user-agent"), requestId: req.requestId };
}

function requireAuth(req: Request): AuthContext {
  if (req.auth?.kind !== "customer") throw new AuthenticationError();
  return req.auth;
}

function presentAuthenticated(result: AuthenticatedResult): Record<string, unknown> {
  return {
    status: result.status,
    userId: result.userId,
    sessionId: result.sessionId,
    deviceId: result.deviceId,
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
  };
}

function presentLogin(result: AuthenticatedResult | SecondFactorRequired): Record<string, unknown> {
  if (result.status === "authenticated") return presentAuthenticated(result);
  return {
    status: result.status,
    loginChallengeId: result.loginChallengeId,
    method: result.method,
    expiresAt: result.expiresAt.toISOString(),
  };
}

export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly passkeys: PasskeyService,
  ) {}

  createDeviceChallenge = async (req: Request, res: Response): Promise<void> => {
    const challenge = await this.auth.createDeviceChallenge(contextOf(req));
    res.status(201).json({ challengeId: challenge.challengeId, challenge: challenge.challenge, expiresAt: challenge.expiresAt.toISOString() });
  };

  startRegistration = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, registrationStartSchema);
    const result = await this.auth.startRegistration(
      { phone: body.phone, locale: body.locale, ...(body.countryHint === undefined ? {} : { countryHint: body.countryHint }) },
      contextOf(req),
    );
    res.status(202).json({ challengeId: result.challengeId, expiresAt: result.expiresAt.toISOString() });
  };

  completeRegistration = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, registrationCompleteSchema);
    const result = await this.auth.completeRegistration(body, contextOf(req));
    res.status(201).json(presentAuthenticated(result));
  };

  startPasswordReset = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, passwordResetStartSchema);
    const result = await this.auth.startPasswordReset(
      { phone: body.phone, locale: body.locale, ...(body.countryHint === undefined ? {} : { countryHint: body.countryHint }) },
      contextOf(req),
    );
    res.status(202).json({ challengeId: result.challengeId, expiresAt: result.expiresAt.toISOString() });
  };

  completePasswordReset = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, passwordResetCompleteSchema);
    await this.auth.completePasswordReset(
      {
        challengeId: body.challengeId,
        code: body.code,
        phone: body.phone,
        password: body.password,
        ...(body.countryHint === undefined ? {} : { countryHint: body.countryHint }),
        ...(body.totpCode === undefined ? {} : { totpCode: body.totpCode }),
      },
      contextOf(req),
    );
    res.status(204).end();
  };

  startLogin = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, loginStartSchema);
    const result = await this.auth.startLogin({ ...body, signedRequest: signedRequestParts(req) }, contextOf(req));
    res.status(200).json(presentLogin(result));
  };

  completeLogin = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, loginCompleteSchema);
    const result = await this.auth.completeLogin(body, contextOf(req));
    res.status(200).json(presentAuthenticated(result));
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, refreshSchema);
    const result = await this.auth.refresh({ refreshToken: body.refreshToken, signedRequest: signedRequestParts(req) }, contextOf(req));
    res.status(200).json(presentAuthenticated(result));
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    await this.auth.logout(auth.subjectId, auth.sessionId, contextOf(req));
    res.status(204).end();
  };

  listSessions = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const sessions = await this.auth.listSessions(auth.subjectId);
    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        audience: session.audience,
        deviceId: session.device_id,
        deviceName: session.device_name,
        ipAddress: session.ip_address,
        userAgent: session.user_agent,
        createdAt: session.created_at.toISOString(),
        lastUsedAt: session.last_used_at.toISOString(),
        current: session.id === auth.sessionId,
      })),
    });
  };

  revokeSession = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const params = validatedParams(req, sessionIdParamsSchema);
    await this.auth.revokeSession(auth.subjectId, params.sessionId, contextOf(req));
    res.status(204).end();
  };

  revokeOtherSessions = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const count = await this.auth.revokeOtherSessions(auth.subjectId, auth.sessionId, contextOf(req));
    res.json({ revoked: count });
  };

  listDevices = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const devices = await this.auth.listDevices(auth.subjectId);
    res.json({
      devices: devices.map((device) => ({
        id: device.id,
        platform: device.platform,
        name: device.device_name,
        appVersion: device.app_version,
        osVersion: device.os_version,
        createdAt: device.created_at.toISOString(),
        lastSeenAt: device.last_seen_at?.toISOString() ?? null,
        current: device.id === auth.deviceId,
      })),
    });
  };

  revokeDevice = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const params = validatedParams(req, deviceIdParamsSchema);
    await this.auth.revokeDevice(auth.subjectId, params.deviceId, contextOf(req));
    res.status(204).end();
  };

  startTotpEnrollment = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const enrollment = await this.mfa.startEnrollment(auth.subjectId);
    res.status(201).json(enrollment);
  };

  confirmTotpEnrollment = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const body = validatedBody(req, totpCodeSchema);
    await this.mfa.confirmEnrollment(auth.subjectId, body.code, contextOf(req));
    res.status(204).end();
  };

  disableTotp = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const body = validatedBody(req, totpCodeSchema);
    await this.mfa.disable(auth.subjectId, body.code, contextOf(req));
    res.status(204).end();
  };

  passkeyRegistrationOptions = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    res.status(201).json(await this.passkeys.registrationOptions(auth.subjectId));
  };

  passkeyRegistrationVerify = async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const body = validatedBody(req, passkeyRegistrationVerifySchema);
    const result = await this.passkeys.verifyRegistration(
      auth.subjectId,
      {
        challengeId: body.challengeId,
        response: body.response as RegistrationResponseJSON,
        ...(body.nickname === undefined ? {} : { nickname: body.nickname }),
      },
      contextOf(req),
    );
    res.status(201).json(result);
  };

  passkeyAuthenticationOptions = async (_req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.passkeys.authenticationOptions());
  };

  passkeyAuthenticationVerify = async (req: Request, res: Response): Promise<void> => {
    const body = validatedBody(req, passkeyAuthenticationVerifySchema);
    const result = await this.passkeys.verifyAuthentication(
      { challengeId: body.challengeId, response: body.response as AuthenticationResponseJSON },
      contextOf(req),
    );
    res.status(200).json(presentAuthenticated(result));
  };
}
