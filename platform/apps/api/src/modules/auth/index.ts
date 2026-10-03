import type { Router } from "express";
import type { Logger } from "pino";

import { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider } from "../../lib/crypto/fieldEncryption.js";
import { LogSmsSender, TwilioSmsSender } from "../../lib/sms/smsSender.js";
import type { SmsSender } from "../../lib/sms/smsSender.js";
import { loadAppleAppAttestationRoot } from "./attestation/appleRootCa.js";
import { AppAttestVerifier } from "./attestation/appAttest.js";
import { PlayIntegrityVerifier } from "./attestation/playIntegrity.js";
import { CompositeAttestationVerifier } from "./attestation/types.js";
import type { AttestationVerifier } from "./attestation/types.js";
import { AuthController } from "./auth.controller.js";
import { authRoutes } from "./auth.routes.js";
import type { AuthRateLimiters } from "./auth.routes.js";
import { AuthService } from "./auth.service.js";
import { DeviceBindingService } from "./deviceBinding.service.js";
import { MfaService } from "./mfa.service.js";
import { OtpService } from "./otp.service.js";
import { PasskeyService } from "./passkey.service.js";
import { createPwnedPasswordsChecker, PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";

/**
 * Assemblage du module d'authentification client. Les dépendances externes
 * (SMS, attestation, contrôle de fuite des mots de passe) sont construites à
 * partir de la configuration et peuvent être substituées (tests).
 */

export interface AuthModuleOverrides {
  readonly sms?: SmsSender;
  readonly attestation?: AttestationVerifier;
  readonly breachChecker?: ((password: string) => Promise<boolean>) | null;
}

export interface AuthModule {
  readonly router: Router;
  readonly deviceBinding: DeviceBindingService;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly mfa: MfaService;
}

export function createAuthModule(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly sessions: SessionValidator;
  readonly limiters: AuthRateLimiters;
  readonly overrides?: AuthModuleOverrides;
}): AuthModule {
  const { config, pool, logger } = params;
  const auth = config.auth;

  const sms =
    params.overrides?.sms ??
    (auth.sms.provider === "twilio"
      ? new TwilioSmsSender(auth.sms.accountSid, auth.sms.authToken, auth.sms.messagingServiceSid)
      : new LogSmsSender(logger));

  const attestation =
    params.overrides?.attestation ??
    new CompositeAttestationVerifier(
      auth.appAttest === undefined
        ? undefined
        : new AppAttestVerifier({ appIds: auth.appAttest.appIds, allowDevelopment: auth.appAttest.allowDevelopment, rootCertificate: loadAppleAppAttestationRoot() }),
      auth.playIntegrity === undefined
        ? undefined
        : new PlayIntegrityVerifier({
            packageName: auth.playIntegrity.packageName,
            certificateDigests: auth.playIntegrity.certificateDigests,
            serviceAccount: auth.playIntegrity.serviceAccount,
          }),
    );

  const breachChecker =
    params.overrides?.breachChecker === undefined
      ? auth.passwordBreachCheck
        ? createPwnedPasswordsChecker(fetch, (error) => {
            logger.warn({ err: error }, "contrôle Have I Been Pwned indisponible");
          })
        : undefined
      : (params.overrides.breachChecker ?? undefined);

  const indexer = new BlindIndexer(config.crypto.blindIndexKey);
  const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
  const deviceBinding = new DeviceBindingService(pool);
  const mfa = new MfaService(pool, encryptor);
  const service = new AuthService({
    pool,
    logger,
    passwords: new PasswordService(breachChecker),
    otp: new OtpService(auth.otpHmacKey, indexer, sms),
    tokens: new TokenService(config.jwt.issuer, auth.customerSigningKey),
    mfa,
    deviceBinding,
    attestation,
    indexer,
    encryptor,
    piiKeyId: config.crypto.piiKeyring.activeKeyId,
  });
  const passkeys = new PasskeyService(pool, auth.webauthn, service);
  const controller = new AuthController(service, mfa, passkeys);
  const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);

  return {
    router: authRoutes({ controller, verifier, sessions: params.sessions, deviceBinding, limiters: params.limiters }),
    deviceBinding,
    encryptor,
    indexer,
    mfa,
  };
}
