import type { Server } from "node:http";

import { createApp } from "./app.js";
import { AccessTokenVerifier } from "./auth/accessToken.js";
import { PostgresPermissionChecker } from "./auth/permissions.js";
import { PostgresSessionValidator } from "./auth/sessions.js";
import { ConfigurationError, loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { checkDatabase, createDatabasePool } from "./db/pool.js";
import { createRedisRateLimiter } from "./middlewares/rateLimit.js";
import { checkRedis, createRedisClient } from "./lib/redis.js";
import { createAuthModule } from "./modules/auth/index.js";
import { createFxModule } from "./modules/fx/index.js";
import { createLedgerModule } from "./modules/ledger/index.js";

/**
 * Point d'entrée du processus : construit les ressources, démarre le serveur
 * HTTP et assure un arrêt propre (SIGTERM du conteneur) : plus de nouvelles
 * connexions, fin des requêtes en cours, fermeture du pool et de Redis.
 */

const SHUTDOWN_TIMEOUT_MS = 25_000;

/** Limite globale par IP : 300 requêtes / minute, blocage 60 s au-delà. */
const GLOBAL_RATE_LIMIT = { keyPrefix: "global-ip", points: 300, durationSeconds: 60, blockDurationSeconds: 60 } as const;
/** Routes d'authentification publiques : 60 requêtes / 10 min par IP. */
const AUTH_PUBLIC_RATE_LIMIT = { keyPrefix: "auth-ip", points: 60, durationSeconds: 600, blockDurationSeconds: 600 } as const;
/** Simulateur public de prix : 120 requêtes / 10 min par IP. */
const FX_ESTIMATE_RATE_LIMIT = { keyPrefix: "fx-estimate-ip", points: 120, durationSeconds: 600, blockDurationSeconds: 300 } as const;
/** Devis garantis : 60 / 10 min par client. */
const FX_QUOTE_RATE_LIMIT = { keyPrefix: "fx-quote-subject", points: 60, durationSeconds: 600, blockDurationSeconds: 300 } as const;
/** Inscription / connexion : 10 tentatives / 15 min par numéro de téléphone. */
const AUTH_PHONE_RATE_LIMIT = { keyPrefix: "auth-phone", points: 10, durationSeconds: 900, blockDurationSeconds: 900 } as const;

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

  const logger = createLogger(config);
  const pool = createDatabasePool(config, logger);
  const redis = createRedisClient(config.redisUrl, logger);
  await redis.connect();
  await checkDatabase(pool);

  const sessions = new PostgresSessionValidator(pool);
  const authModule = createAuthModule({
    config,
    pool,
    logger,
    sessions,
    limiters: {
      publicByIp: createRedisRateLimiter(redis, AUTH_PUBLIC_RATE_LIMIT),
      byPhone: createRedisRateLimiter(redis, AUTH_PHONE_RATE_LIMIT),
    },
  });

  const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
  const ledgerModule = createLedgerModule({
    pool,
    verifier,
    sessions,
    permissions: new PostgresPermissionChecker(pool),
    deviceBinding: authModule.deviceBinding,
  });

  const fxModule = createFxModule({
    config,
    pool,
    verifier,
    sessions,
    limiters: {
      estimateByIp: createRedisRateLimiter(redis, FX_ESTIMATE_RATE_LIMIT),
      quotesBySubject: createRedisRateLimiter(redis, FX_QUOTE_RATE_LIMIT),
    },
  });

  const app = createApp({
    config,
    logger,
    healthChecks: [
      { name: "postgres", check: () => checkDatabase(pool) },
      { name: "redis", check: () => checkRedis(redis) },
    ],
    globalRateLimiter: createRedisRateLimiter(redis, GLOBAL_RATE_LIMIT),
    mountRoutes: (application) => {
      application.use(authModule.router);
      application.use(ledgerModule.router);
      application.use(fxModule.router);
    },
  });

  const server: Server = app.listen(config.http.port, config.http.host, () => {
    logger.info({ port: config.http.port, env: config.appEnv }, "API démarrée");
  });
  // Protection contre les clients lents (Slowloris) et connexions pendantes.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "arrêt demandé");
    const forceExit = setTimeout(() => {
      logger.error("arrêt forcé : délai dépassé");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((closeError) => {
      if (closeError !== undefined) logger.error({ err: closeError }, "erreur à la fermeture du serveur HTTP");
      Promise.allSettled([pool.end(), redis.quit()])
        .then(() => {
          logger.info("arrêt terminé");
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    });
    server.closeIdleConnections();
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
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "exception non interceptée");
    shutdown("uncaughtException");
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Échec du démarrage : ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
