import { Router } from "express";
import type { Logger } from "pino";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import type { ComplianceService } from "../aml/compliance.service.js";
import { createComplianceService } from "../aml/index.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import type { MfaService } from "../auth/mfa.service.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { CircuitBreaker } from "../payments/circuitBreaker.js";
import { FlutterwaveClient } from "../payments/providers/flutterwave.client.js";
import { StripeClient } from "../payments/providers/stripe.client.js";
import { ThunesClient } from "../payments/providers/thunes.client.js";
import type { PayinProvider, PaymentProviderName, PayoutProvider } from "../payments/providers/types.js";
import { recipientRoutes } from "../recipients/recipients.routes.js";
import { RecipientService } from "../recipients/recipients.service.js";
import type { WebhookInbox } from "../webhooks/webhookInbox.js";
import { PaymentOrchestrator } from "./payment.orchestrator.js";
import { paymentWebhookRoutes, registerPaymentWebhookHandlers } from "./payments.webhooks.js";
import type { PaymentWebhookProcessing } from "./payments.webhooks.js";
import { transferRoutes } from "./transfers.routes.js";
import { TransferService } from "./transfers.service.js";

export interface PaymentProviders {
  readonly payin: ReadonlyMap<PaymentProviderName, PayinProvider>;
  readonly payout: ReadonlyMap<PaymentProviderName, PayoutProvider>;
}

/** Clients prestataires configurés (Stripe : encaissement ; Flutterwave : les deux ; Thunes : paiement sortant). */
export function configuredPaymentProviders(config: AppConfig, fetchImpl: typeof fetch = fetch): PaymentProviders {
  const payin = new Map<PaymentProviderName, PayinProvider>();
  const payout = new Map<PaymentProviderName, PayoutProvider>();
  const { stripe, flutterwave, thunes } = config.payments;
  if (stripe !== undefined) {
    payin.set("stripe", new StripeClient({ secretKey: stripe.secretKey, publishableKey: stripe.publishableKey, apiVersion: stripe.apiVersion }, fetchImpl));
  }
  if (flutterwave !== undefined) {
    const client = new FlutterwaveClient({ secretKey: flutterwave.secretKey, redirectUrl: flutterwave.redirectUrl }, fetchImpl);
    payin.set("flutterwave", client);
    payout.set("flutterwave", client);
  }
  if (thunes !== undefined) {
    payout.set(
      "thunes",
      new ThunesClient(
        { baseUrl: thunes.baseUrl, apiKey: thunes.apiKey, apiSecret: thunes.apiSecret, callbackUrl: thunes.callbackUrl, settlementCurrency: thunes.settlementCurrency },
        fetchImpl,
      ),
    );
  }
  return { payin, payout };
}

export interface PaymentStack {
  readonly orchestrator: PaymentOrchestrator;
  readonly recipients: RecipientService;
  readonly breaker: CircuitBreaker;
  readonly ledger: LedgerService;
  readonly compliance: ComplianceService;
}

export function createPaymentStack(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly providers: PaymentProviders;
  readonly inbox: WebhookInbox;
}): PaymentStack {
  const { config, pool, logger } = params;
  const ledger = new LedgerService();
  const breaker = new CircuitBreaker(pool, { failureThreshold: config.payments.circuitFailureThreshold, openSeconds: config.payments.circuitOpenSeconds });
  const recipients = new RecipientService({ pool, encryptor: params.encryptor, indexer: params.indexer, piiKeyId: config.crypto.piiKeyring.activeKeyId });
  const compliance = createComplianceService(config, params.encryptor, logger);
  const orchestrator = new PaymentOrchestrator({
    pool,
    logger,
    ledger,
    recipients,
    encryptor: params.encryptor,
    breaker,
    compliance,
    payinProviders: params.providers.payin,
    payoutProviders: params.providers.payout,
    options: { payoutMaxRoutes: config.payments.payoutMaxRoutes },
  });
  registerPaymentWebhookHandlers(params.inbox, orchestrator, logger);
  return { orchestrator, recipients, breaker, ledger, compliance };
}

export interface TransfersModule {
  readonly router: Router;
  readonly transfers: TransferService;
  readonly stack: PaymentStack;
}

export function createTransfersModule(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly deviceBinding: DeviceBindingService;
  readonly mfa: MfaService;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly inbox: WebhookInbox;
  readonly limiters: { readonly transfersBySubject: RateLimiterAbstract; readonly recipientsBySubject: RateLimiterAbstract };
  readonly providers?: PaymentProviders;
  readonly dispatch?: "inline" | "background";
  readonly webhookProcessing?: PaymentWebhookProcessing;
}): TransfersModule {
  const { config } = params;
  const providers = params.providers ?? configuredPaymentProviders(config);
  const stack = createPaymentStack({ ...params, providers });
  const transfers = new TransferService({
    pool: params.pool,
    logger: params.logger,
    ledger: stack.ledger,
    mfa: params.mfa,
    encryptor: params.encryptor,
    breaker: stack.breaker,
    payinProviders: providers.payin,
    orchestrator: stack.orchestrator,
    compliance: stack.compliance,
    dispatch: params.dispatch ?? "background",
  });

  const router = Router();
  router.use(
    recipientRoutes({
      recipients: stack.recipients,
      verifier: params.verifier,
      sessions: params.sessions,
      deviceBinding: params.deviceBinding,
      limiters: { createBySubject: params.limiters.recipientsBySubject },
    }),
  );
  router.use(
    transferRoutes({
      transfers,
      verifier: params.verifier,
      sessions: params.sessions,
      deviceBinding: params.deviceBinding,
      limiters: { createBySubject: params.limiters.transfersBySubject },
    }),
  );
  router.use(
    paymentWebhookRoutes({
      inbox: params.inbox,
      logger: params.logger,
      processing: params.webhookProcessing ?? "background",
      stripe: config.payments.stripe === undefined ? undefined : { webhookSecret: config.payments.stripe.webhookSecret },
      flutterwave: config.payments.flutterwave === undefined ? undefined : { webhookHash: config.payments.flutterwave.webhookHash },
      thunes: config.payments.thunes === undefined ? undefined : { allowedIps: config.payments.thunes.callbackAllowedIps },
    }),
  );
  return { router, transfers, stack };
}
