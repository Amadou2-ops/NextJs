import { AccessTokenVerifier } from "../../src/auth/accessToken.js";
import { PostgresPermissionChecker } from "../../src/auth/permissions.js";
import { PostgresSessionValidator } from "../../src/auth/sessions.js";
import { createMemoryRateLimiter } from "../../src/middlewares/rateLimit.js";
import { createAuthModule } from "../../src/modules/auth/index.js";
import { BlindIndexer } from "../../src/lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider } from "../../src/lib/crypto/fieldEncryption.js";
import { createFxModule } from "../../src/modules/fx/index.js";
import { createKycModule } from "../../src/modules/kyc/index.js";
import { WebhookInbox } from "../../src/modules/webhooks/webhookInbox.js";
import { createLedgerModule } from "../../src/modules/ledger/index.js";
import { buildTestConfig, createApiPool, createTestKeys, silentLogger } from "./fixtures.js";

interface RouteLayer {
  readonly route?: { readonly path: string; readonly methods: Readonly<Record<string, boolean>> };
}

/** Liste (méthode, chemin) des routes des modules montés par l'API. */
export async function routesForContract(): Promise<readonly { readonly method: string; readonly path: string }[]> {
  // Prestataires KYC configurés : leurs routes de webhook sont alors montées.
  const config = buildTestConfig(await createTestKeys(), {
    ONFIDO_API_TOKEN: `api_sandbox.${"a".repeat(24)}`,
    ONFIDO_WEBHOOK_TOKEN: "w".repeat(32),
    ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
    SMILE_ID_PARTNER_ID: "2343",
    SMILE_ID_API_KEY: "k".repeat(32),
    SMILE_ID_CALLBACK_URL: "https://api.transfertplus.test/v1/webhooks/smile-id",
  });
  const pool = createApiPool(config);
  try {
    const limiter = createMemoryRateLimiter({ keyPrefix: "contract", points: 1, durationSeconds: 1, blockDurationSeconds: 0 });
    const module = createAuthModule({
      config,
      pool,
      logger: silentLogger,
      sessions: new PostgresSessionValidator(pool),
      limiters: { publicByIp: limiter, byPhone: limiter },
      overrides: { breachChecker: null },
    });
    const ledgerModule = createLedgerModule({
      pool,
      verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
      sessions: new PostgresSessionValidator(pool),
      permissions: new PostgresPermissionChecker(pool),
      deviceBinding: module.deviceBinding,
    });
    const fxModule = createFxModule({
      config,
      pool,
      verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
      sessions: new PostgresSessionValidator(pool),
      limiters: { estimateByIp: limiter, quotesBySubject: limiter },
    });
    const kycModule = createKycModule({
      config,
      pool,
      logger: silentLogger,
      verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
      sessions: new PostgresSessionValidator(pool),
      deviceBinding: module.deviceBinding,
      encryptor: new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys)),
      indexer: new BlindIndexer(config.crypto.blindIndexKey),
      inbox: new WebhookInbox(pool, silentLogger),
      limiters: { startBySubject: limiter },
    });
    // Le routeur KYC regroupe deux sous-routeurs (client, webhooks).
    const kycStack = (kycModule.router as unknown as { readonly stack: readonly { readonly handle: unknown }[] }).stack.map((layer) => layer.handle);
    const stack = [module.router, ledgerModule.router, fxModule.router, ...kycStack].flatMap((router) => (router as { readonly stack: readonly RouteLayer[] }).stack);
    return stack.flatMap((layer) =>
      layer.route === undefined
        ? []
        : Object.keys(layer.route.methods).map((method) => ({ method: method.toLowerCase(), path: layer.route?.path ?? "" })),
    );
  } finally {
    await pool.end();
  }
}
