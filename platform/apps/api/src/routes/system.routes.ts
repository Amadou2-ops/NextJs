import { Router } from "express";
import type { Request, Response } from "express";
import type { Logger } from "pino";

import type { PublicJwks } from "../config/env.js";

/**
 * Routes techniques publiques : santé et clés publiques de vérification des
 * jetons clients (JWKS). Les clés du personnel ne sont jamais publiées.
 */

export interface HealthCheck {
  readonly name: string;
  check(): Promise<void>;
}

const HEALTH_CHECK_TIMEOUT_MS = 2_000;

async function runCheck(check: HealthCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`délai dépassé (${HEALTH_CHECK_TIMEOUT_MS} ms)`));
        }, HEALTH_CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function systemRoutes(params: {
  readonly version: string;
  readonly healthChecks: readonly HealthCheck[];
  readonly customerJwks: PublicJwks;
  readonly logger: Logger;
}): Router {
  const router = Router();

  router.get("/v1/health", (_req: Request, res: Response) => {
    void Promise.allSettled(params.healthChecks.map((check) => runCheck(check))).then((results) => {
      const failing = results
        .map((result, index) => ({ result, name: params.healthChecks[index]?.name ?? `check-${index}` }))
        .filter(({ result }) => result.status === "rejected");
      if (failing.length === 0) {
        res.status(200).json({ status: "ok", version: params.version });
        return;
      }
      for (const { name, result } of failing) {
        params.logger.error({ dependency: name, err: result.status === "rejected" ? result.reason : undefined }, "dépendance indisponible");
      }
      // Les noms des dépendances défaillantes ne sont pas exposés publiquement.
      res
        .status(503)
        .type("application/problem+json")
        .send(
          JSON.stringify({
            type: "https://docs.transfertplus.example/errors/service-unavailable",
            title: "Service indisponible",
            status: 503,
            code: "SERVICE_UNAVAILABLE",
          }),
        );
    });
  });

  router.get("/.well-known/jwks.json", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.removeHeader("Pragma");
    res.status(200).json({ keys: params.customerJwks.keys });
  });

  return router;
}
