import { Router } from "express";
import type { Logger } from "pino";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import type { WebhookInbox } from "../webhooks/webhookInbox.js";
import { kycRoutes } from "./kyc.routes.js";
import { KycService } from "./kyc.service.js";
import { kycWebhookRoutes, registerKycWebhookHandlers } from "./kyc.webhooks.js";
import type { WebhookProcessing } from "./kyc.webhooks.js";
import { OnfidoClient } from "./providers/onfido.client.js";
import { SmileIdClient } from "./providers/smileId.client.js";
import type { KycProvider, KycProviderName } from "./providers/types.js";

export interface KycModule {
  readonly router: Router;
  readonly service: KycService;
}

/** Prestataires configurés (clients HTTP réels, ou substituts injectés en test). */
export function configuredKycProviders(config: AppConfig, fetchImpl: typeof fetch = fetch): ReadonlyMap<KycProviderName, KycProvider> {
  const providers = new Map<KycProviderName, KycProvider>();
  const onfido = config.kyc.onfido;
  if (onfido !== undefined) {
    providers.set("onfido", new OnfidoClient({ apiToken: onfido.apiToken, baseUrl: onfido.baseUrl, workflows: onfido.workflows }, fetchImpl));
  }
  const smile = config.kyc.smileId;
  if (smile !== undefined) {
    providers.set(
      "smile_id",
      new SmileIdClient(
        { partnerId: smile.partnerId, apiKey: smile.apiKey, environment: smile.environment, baseUrl: smile.baseUrl, callbackUrl: smile.callbackUrl },
        fetchImpl,
      ),
    );
  }
  return providers;
}

export function createKycService(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly providers: ReadonlyMap<KycProviderName, KycProvider>;
}): KycService {
  return new KycService({
    pool: params.pool,
    logger: params.logger,
    providers: params.providers,
    encryptor: params.encryptor,
    indexer: params.indexer,
    piiKeyId: params.config.crypto.piiKeyring.activeKeyId,
    options: {
      verificationValidityDays: params.config.kyc.verificationValidityDays,
      sessionTtlHours: params.config.kyc.sessionTtlHours,
      maxAttemptsPer30Days: params.config.kyc.maxAttemptsPer30Days,
    },
  });
}

export function createKycModule(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly deviceBinding: DeviceBindingService;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly inbox: WebhookInbox;
  readonly limiters: { readonly startBySubject: RateLimiterAbstract };
  readonly providers?: ReadonlyMap<KycProviderName, KycProvider>;
  readonly webhookProcessing?: WebhookProcessing;
}): KycModule {
  const { config } = params;
  const service = createKycService({ ...params, providers: params.providers ?? configuredKycProviders(config) });
  registerKycWebhookHandlers(params.inbox, service, params.logger);

  const router = Router();
  router.use(
    kycRoutes({
      kyc: service,
      verifier: params.verifier,
      sessions: params.sessions,
      deviceBinding: params.deviceBinding,
      limiters: params.limiters,
    }),
  );
  router.use(
    kycWebhookRoutes({
      inbox: params.inbox,
      logger: params.logger,
      processing: params.webhookProcessing ?? "background",
      onfido: config.kyc.onfido === undefined ? undefined : { webhookToken: config.kyc.onfido.webhookToken },
      smileId:
        config.kyc.smileId === undefined
          ? undefined
          : {
              partnerId: config.kyc.smileId.partnerId,
              apiKey: config.kyc.smileId.apiKey,
              toleranceSeconds: config.kyc.smileId.callbackToleranceSeconds,
            },
    }),
  );
  return { router, service };
}
