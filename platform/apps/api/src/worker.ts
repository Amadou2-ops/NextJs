import { hostname } from "node:os";

import { ConfigurationError, loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { checkDatabase, createDatabasePool } from "./db/pool.js";
import { ChainAnchorJob } from "./jobs/anchor.job.js";
import { MaintenanceJob } from "./jobs/maintenance.job.js";
import { ReconciliationJob } from "./jobs/reconciliation.job.js";
import { JobScheduler } from "./jobs/scheduler.js";
import type { Job } from "./jobs/scheduler.js";
import { parsePemBundle, TimestampAuthorityClient } from "./lib/crypto/rfc3161.js";

/**
 * Processus de tâches de fond (séparé de l'API HTTP) : rapprochement
 * d'intégrité du registre, ancrage RFC 3161, purges. Plusieurs instances
 * peuvent tourner : chaque tâche est protégée par un verrou consultatif.
 */

const MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000;

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
