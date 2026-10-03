import "./types/express-augmentation.js";

import express from "express";
import type { Express, Request } from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AppConfig } from "./config/env.js";
import { strictCors } from "./middlewares/cors.js";
import { errorHandler, notFound } from "./middlewares/errorHandler.js";
import { jsonBody } from "./middlewares/jsonBody.js";
import { byClientIp, rateLimit } from "./middlewares/rateLimit.js";
import { requestId } from "./middlewares/requestId.js";
import { securityHeaders } from "./middlewares/securityHeaders.js";
import { systemRoutes } from "./routes/system.routes.js";
import type { HealthCheck } from "./routes/system.routes.js";

/**
 * Assemblage de l'application Express. Toutes les dépendances sont injectées
 * (configuration, journal, contrôles de santé, limiteur) : l'application est
 * testable sans réseau et ne crée aucune ressource elle-même.
 *
 * Ordre des couches :
 *   identifiant de corrélation → journal d'accès → en-têtes de sécurité →
 *   CORS strict → limitation globale par IP → corps JSON → routes →
 *   404 → gestionnaire d'erreurs.
 *
 * Les modules métier (authentification, registre, change, KYC, transferts,
 * AML, administration) se montent via `mountRoutes` dans les phases
 * suivantes.
 */

export interface AppDependencies {
  readonly config: Pick<AppConfig, "appVersion" | "corsAllowedOrigins" | "http" | "jwt">;
  readonly logger: Logger;
  readonly healthChecks: readonly HealthCheck[];
  readonly globalRateLimiter: RateLimiterAbstract;
  readonly mountRoutes?: (app: Express) => void;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", deps.config.http.trustProxyHops);
  app.set("query parser", "simple");

  app.use(requestId());
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => (req as Request).requestId,
      customLogLevel: (_req, res, error) => {
        if (error !== undefined || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      autoLogging: { ignore: (req) => req.url === "/v1/health" },
      serializers: {
        req: (req: { method?: string; url?: string; id?: unknown }) => ({
          id: req.id,
          method: req.method,
          // Chemin sans paramètres de requête (peuvent contenir des données personnelles).
          path: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(securityHeaders());
  app.use(strictCors(deps.config.corsAllowedOrigins));
  app.use(rateLimit(deps.globalRateLimiter, byClientIp));
  app.use(jsonBody());

  app.use(
    systemRoutes({
      version: deps.config.appVersion,
      healthChecks: deps.healthChecks,
      customerJwks: deps.config.jwt.customerJwks,
      logger: deps.logger,
    }),
  );
  deps.mountRoutes?.(app);

  app.use(notFound());
  app.use(errorHandler(deps.logger));
  return app;
}
