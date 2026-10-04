import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Redis } from "ioredis";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import { RateLimitedError } from "../lib/errors.js";

/**
 * Limitation de débit partagée entre instances (Redis). Si Redis devient
 * indisponible, un limiteur en mémoire locale prend le relais : la limitation
 * est dégradée (par instance) mais jamais désactivée.
 */

export interface RateLimitPolicy {
  /** Préfixe des clés Redis, unique par politique. */
  readonly keyPrefix: string;
  /** Nombre de requêtes autorisées par fenêtre. */
  readonly points: number;
  /** Durée de la fenêtre, en secondes. */
  readonly durationSeconds: number;
  /** Blocage supplémentaire après dépassement, en secondes. */
  readonly blockDurationSeconds: number;
}

export function createRedisRateLimiter(redis: Redis, policy: RateLimitPolicy): RateLimiterAbstract {
  return new RateLimiterRedis({
    storeClient: redis,
    useRedisPackage: false,
    keyPrefix: `rl:${policy.keyPrefix}`,
    points: policy.points,
    duration: policy.durationSeconds,
    blockDuration: policy.blockDurationSeconds,
    insuranceLimiter: createMemoryRateLimiter(policy),
  });
}

export function createMemoryRateLimiter(policy: RateLimitPolicy): RateLimiterAbstract {
  return new RateLimiterMemory({
    keyPrefix: `rl-mem:${policy.keyPrefix}`,
    points: policy.points,
    duration: policy.durationSeconds,
    blockDuration: policy.blockDurationSeconds,
  });
}

export type RateLimitKey = (req: Request) => string | undefined;

/** Clé par adresse IP cliente (req.ip, tenant compte de TRUST_PROXY_HOPS). */
export const byClientIp: RateLimitKey = (req) => (req.ip === undefined ? undefined : `ip:${req.ip}`);

/** Clé par identité authentifiée, à défaut par IP. */
export const bySubjectOrIp: RateLimitKey = (req) =>
  req.auth === undefined ? byClientIp(req) : `${req.auth.kind}:${req.auth.subjectId}`;

export function rateLimit(limiter: RateLimiterAbstract, keyOf: RateLimitKey): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyOf(req) ?? "unknown-client";
    limiter
      .consume(key, 1)
      .then((result) => {
        setRateLimitHeaders(res, limiter.points, result);
        next();
      })
      .catch((rejection: unknown) => {
        if (rejection instanceof RateLimiterRes) {
          setRateLimitHeaders(res, limiter.points, rejection);
          const retryAfter = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
          res.setHeader("Retry-After", String(retryAfter));
          next(new RateLimitedError(retryAfter));
          return;
        }
        // Erreur du magasin sans limiteur de secours disponible : on refuse
        // plutôt que de laisser passer sans contrôle.
        next(rejection instanceof Error ? rejection : new Error("échec du limiteur de débit"));
      });
  };
}

function setRateLimitHeaders(res: Response, limit: number, result: RateLimiterRes): void {
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, result.remainingPoints)));
  res.setHeader("RateLimit-Reset", String(Math.max(0, Math.ceil(result.msBeforeNext / 1000))));
}
