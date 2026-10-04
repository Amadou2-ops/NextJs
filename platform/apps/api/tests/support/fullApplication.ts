import { randomUUID } from "node:crypto";

import type { Express, Router } from "express";

import { AccessTokenVerifier } from "../../src/auth/accessToken.js";
import { PostgresPermissionChecker } from "../../src/auth/permissions.js";
import { PostgresSessionValidator } from "../../src/auth/sessions.js";
import type { AppConfig } from "../../src/config/env.js";
import type { DatabasePool } from "../../src/db/pool.js";
import { BlindIndexer } from "../../src/lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider } from "../../src/lib/crypto/fieldEncryption.js";
import { createMemoryRateLimiter } from "../../src/middlewares/rateLimit.js";
import { createAuthModule } from "../../src/modules/auth/index.js";
import { MfaService } from "../../src/modules/auth/mfa.service.js";
import { createBackofficeModule } from "../../src/modules/backoffice/index.js";
import { createFxModule } from "../../src/modules/fx/index.js";
import { createKycModule } from "../../src/modules/kyc/index.js";
import { createLedgerModule } from "../../src/modules/ledger/index.js";
import { createTransfersModule } from "../../src/modules/transfers/index.js";
import { WebhookInbox } from "../../src/modules/webhooks/webhookInbox.js";
import { buildTestApp, buildTestConfig, createApiPool, createTestKeys } from "./fixtures.js";
import type { TestKeys } from "./fixtures.js";
import { silentLogger } from "./fixtures.js";

/**
 * Application complète, assemblée comme dans src/server.ts (même ordre de
 * montage, tous les prestataires configurés) : sert au contrat OpenAPI et aux
 * matrices de sécurité, qui doivent couvrir CHAQUE route exposée.
 */

export interface FullApplication {
  readonly config: AppConfig;
  readonly keys: TestKeys;
  readonly pool: DatabasePool;
  readonly app: Express;
  /** Routeurs dans l'ordre de montage (sous-routeurs aplatis). */
  readonly routers: readonly Router[];
  readonly close: () => Promise<void>;
}

export async function createFullApplication(options: { readonly rateLimitPoints?: number } = {}): Promise<FullApplication> {
  const keys = await createTestKeys();
  const config = buildTestConfig(keys, {
    ONFIDO_API_TOKEN: `api_sandbox.${"a".repeat(24)}`,
    ONFIDO_WEBHOOK_TOKEN: "w".repeat(32),
    ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
    SMILE_ID_PARTNER_ID: "2343",
    SMILE_ID_API_KEY: "k".repeat(32),
    SMILE_ID_CALLBACK_URL: "https://api.transfertplus.test/v1/webhooks/smile-id",
    STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}`,
    STRIPE_PUBLISHABLE_KEY: `pk_test_${"b".repeat(24)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${"c".repeat(32)}`,
    FLUTTERWAVE_SECRET_KEY: `FLWSECK_TEST-${"d".repeat(32)}-X`,
    FLUTTERWAVE_WEBHOOK_HASH: "f".repeat(32),
    FLUTTERWAVE_REDIRECT_URL: "https://app.transfertplus.test/retour",
    THUNES_BASE_URL: "https://api-mt.thunes.test",
    THUNES_API_KEY: "key-0001",
    THUNES_API_SECRET: "s".repeat(24),
    THUNES_CALLBACK_URL: "https://api.transfertplus.test/v1/webhooks/thunes",
  });
  const pool = createApiPool(config);
  const limiter = createMemoryRateLimiter({ keyPrefix: `full-${randomUUID()}`, points: options.rateLimitPoints ?? 10_000, durationSeconds: 60, blockDurationSeconds: 0 });
  const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
  const sessions = new PostgresSessionValidator(pool);
  const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
  const indexer = new BlindIndexer(config.crypto.blindIndexKey);
  const inbox = new WebhookInbox(pool, silentLogger);

  const auth = createAuthModule({ config, pool, logger: silentLogger, sessions, limiters: { publicByIp: limiter, byPhone: limiter }, overrides: { breachChecker: null } });
  const ledger = createLedgerModule({ pool, verifier, sessions, permissions: new PostgresPermissionChecker(pool), deviceBinding: auth.deviceBinding });
  const fx = createFxModule({ config, pool, verifier, sessions, limiters: { estimateByIp: limiter, quotesBySubject: limiter } });
  const kyc = createKycModule({ config, pool, logger: silentLogger, verifier, sessions, deviceBinding: auth.deviceBinding, encryptor, indexer, inbox, limiters: { startBySubject: limiter } });
  const transfers = createTransfersModule({
    config,
    pool,
    logger: silentLogger,
    verifier,
    sessions,
    deviceBinding: auth.deviceBinding,
    mfa: new MfaService(pool, encryptor),
    encryptor,
    indexer,
    inbox,
    limiters: { transfersBySubject: limiter, recipientsBySubject: limiter },
  });
  const backoffice = createBackofficeModule({
    config,
    pool,
    logger: silentLogger,
    verifier,
    sessions,
    encryptor,
    indexer,
    ledger: transfers.stack.ledger,
    orchestrator: transfers.stack.orchestrator,
    limiters: { loginByIp: limiter, loginByEmail: limiter },
    breachChecker: null,
  });

  const mounted = [backoffice.router, auth.router, ledger.router, fx.router, kyc.router, transfers.router];
  const app = buildTestApp(config, {
    mountRoutes: (application) => {
      for (const router of mounted) application.use(router);
    },
  });
  // Les routeurs KYC et transferts regroupent des sous-routeurs (client, webhooks).
  const nested = (router: Router): Router[] =>
    (router as unknown as { readonly stack: readonly { readonly handle: unknown; readonly route?: unknown }[] }).stack
      .filter((layer) => layer.route === undefined && typeof layer.handle === "function" && "stack" in (layer.handle as object))
      .map((layer) => layer.handle as Router);
  const routers = mounted.flatMap((router) => [router, ...nested(router)]);
  return { config, keys, pool, app, routers, close: () => pool.end() };
}

interface RouteLayer {
  readonly route?: { readonly path: string; readonly methods: Readonly<Record<string, boolean>> };
}

/** Liste (méthode, chemin) de toutes les routes exposées. */
export function routesOf(routers: readonly Router[]): readonly { readonly method: string; readonly path: string }[] {
  return routers
    .flatMap((router) => (router as unknown as { readonly stack: readonly RouteLayer[] }).stack)
    .flatMap((layer) => (layer.route === undefined ? [] : Object.keys(layer.route.methods).map((method) => ({ method: method.toLowerCase(), path: layer.route?.path ?? "" }))));
}
