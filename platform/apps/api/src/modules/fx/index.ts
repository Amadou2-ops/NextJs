import type { Router } from "express";
import type { Logger } from "pino";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import { fxRoutes } from "./fx.routes.js";
import { FixerClient } from "./providers/fixer.client.js";
import { OpenExchangeRatesClient } from "./providers/openExchangeRates.client.js";
import type { RateProvider } from "./providers/types.js";
import { QuoteService } from "./quote.service.js";
import { RateIngestionService } from "./rateIngestion.service.js";

export interface FxModule {
  readonly router: Router;
  readonly quotes: QuoteService;
}

export function createFxModule(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly limiters: { readonly estimateByIp: RateLimiterAbstract; readonly quotesBySubject: RateLimiterAbstract };
}): FxModule {
  const quotes = new QuoteService(params.pool, {
    primaryProvider: params.config.fx.primaryProvider,
    maxRateAgeMs: params.config.fx.maxRateAgeMs,
    maxDivergenceBps: params.config.fx.maxDivergenceBps,
    quoteTtlSeconds: params.config.fx.quoteTtlSeconds,
  });
  return { router: fxRoutes({ quotes, verifier: params.verifier, sessions: params.sessions, limiters: params.limiters }), quotes };
}

/** Fournisseurs configurés, principal en premier. */
export function configuredRateProviders(config: AppConfig, fetchImpl: typeof fetch = fetch): RateProvider[] {
  const providers: RateProvider[] = [];
  if (config.fx.openExchangeRatesAppId !== undefined) providers.push(new OpenExchangeRatesClient(config.fx.openExchangeRatesAppId, fetchImpl));
  if (config.fx.fixerApiKey !== undefined) providers.push(new FixerClient(config.fx.fixerApiKey, fetchImpl));
  return providers.sort((a, b) => (a.name === config.fx.primaryProvider ? -1 : b.name === config.fx.primaryProvider ? 1 : 0));
}

export function createRateIngestion(config: AppConfig, pool: DatabasePool, logger: Logger): RateIngestionService {
  return new RateIngestionService(pool, logger, config.fx.maxJumpBps);
}
