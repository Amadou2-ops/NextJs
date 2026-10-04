import { hostname } from "node:os";

import { ConfigurationError, loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { checkDatabase, createDatabasePool } from "./db/pool.js";
import { ChainAnchorJob } from "./jobs/anchor.job.js";
import { FxRefreshJob } from "./jobs/fxRefresh.job.js";
import { MaintenanceJob } from "./jobs/maintenance.job.js";
import { ReconciliationJob } from "./jobs/reconciliation.job.js";
import { AmlListsJob } from "./jobs/amlLists.job.js";
import { KycSyncJob } from "./jobs/kycSync.job.js";
import { PaymentSyncJob } from "./jobs/paymentSync.job.js";
import { JobScheduler } from "./jobs/scheduler.js";
import type { Job } from "./jobs/scheduler.js";
import { WebhookRetryJob } from "./jobs/webhookRetry.job.js";
import { BlindIndexer } from "./lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider } from "./lib/crypto/fieldEncryption.js";
import { parsePemBundle, TimestampAuthorityClient } from "./lib/crypto/rfc3161.js";
import { configuredListSources } from "./modules/aml/index.js";
import { ListIngestionService } from "./modules/aml/listIngestion.service.js";
import { configuredRateProviders, createRateIngestion } from "./modules/fx/index.js";
import { configuredKycProviders, createKycService } from "./modules/kyc/index.js";
import { registerKycWebhookHandlers } from "./modules/kyc/kyc.webhooks.js";
import { configuredPaymentProviders, createPaymentStack } from "./modules/transfers/index.js";
import { WebhookInbox } from "./modules/webhooks/webhookInbox.js";

/**
 * Processus de tâches de fond (séparé de l'API HTTP) : rapprochement
 * d'intégrité du registre, ancrage RFC 3161, purges. Plusieurs instances
 * peuvent tourner : chaque tâche est protégée par un verrou consultatif.
 */

const MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000;
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78);
    }
    throw error;
  }
  const logger = createLogger(config).child({ process: "worker" });
  const pool = createDatabasePool(config, logger);
  await checkDatabase(pool);
  const workerId = `${hostname()}:${process.pid}`;

  const jobs: Job[] = [
    new ReconciliationJob(pool, logger, workerId, config.ledger.reconciliationIntervalMs),
    new MaintenanceJob(pool, logger, MAINTENANCE_INTERVAL_MS),
  ];
  const rateProviders = configuredRateProviders(config);
  if (rateProviders.length === 0) {
    logger.warn("aucun fournisseur de taux configuré : les devis seront indisponibles");
  } else {
    jobs.push(new FxRefreshJob(createRateIngestion(config, pool, logger), rateProviders, logger, config.fx.refreshIntervalMs));
  }
  jobs.push(new AmlListsJob(new ListIngestionService(pool, logger), configuredListSources(config), logger, config.aml.listsRefreshMs));
  const kycProviders = configuredKycProviders(config);
  const inbox = new WebhookInbox(pool, logger);
  const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
  const indexer = new BlindIndexer(config.crypto.blindIndexKey);
  const paymentProviders = configuredPaymentProviders(config);
  if (paymentProviders.payin.size === 0 && paymentProviders.payout.size === 0) {
    logger.warn("aucun prestataire de paiement configuré : les transferts sont indisponibles");
  } else {
    const payments = createPaymentStack({ config, pool, logger, encryptor, indexer, providers: paymentProviders, inbox });
    jobs.push(new PaymentSyncJob(payments.orchestrator, logger, config.payments.syncIntervalMs, config.payments.fundingTtlMinutes));
  }
  if (kycProviders.size === 0) {
    logger.warn("aucun prestataire KYC configuré : la vérification d'identité est indisponible");
  } else {
    const kyc = createKycService({
      config,
      pool,
      logger,
      encryptor,
      indexer,
      providers: kycProviders,
    });
    registerKycWebhookHandlers(inbox, kyc, logger);
    jobs.push(new KycSyncJob(kyc, logger, config.kyc.syncIntervalMs));
  }
  jobs.push(new WebhookRetryJob(inbox, logger, WEBHOOK_RETRY_INTERVAL_MS));

  const tsa = config.ledger.timestampAuthority;
  if (tsa === undefined) {
    logger.warn("ancrage externe du registre désactivé (TSA_URL non configurée)");
  } else {
    jobs.push(new ChainAnchorJob(pool, logger, new TimestampAuthorityClient(tsa.url, parsePemBundle(tsa.trustedCertsPem)), tsa.target, config.ledger.anchorIntervalMs));
  }

  const scheduler = new JobScheduler(pool, logger, jobs);
  scheduler.start();
  logger.info({ workerId, jobs: jobs.map((job) => job.name) }, "worker démarré");

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "arrêt du worker demandé");
    const forceExit = setTimeout(() => process.exit(1), 60_000);
    forceExit.unref();
    scheduler
      .stop()
      .then(() => pool.end())
      .then(() => {
        logger.info("worker arrêté");
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "promesse rejetée non gérée");
    shutdown("unhandledRejection");
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Échec du démarrage du worker : ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
