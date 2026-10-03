import { PostgresSessionValidator } from "../../src/auth/sessions.js";
import { createMemoryRateLimiter } from "../../src/middlewares/rateLimit.js";
import { createAuthModule } from "../../src/modules/auth/index.js";
import { buildTestConfig, createApiPool, createTestKeys, silentLogger } from "./fixtures.js";

interface RouteLayer {
  readonly route?: { readonly path: string; readonly methods: Readonly<Record<string, boolean>> };
}

/** Liste (méthode, chemin) des routes du module d'authentification. */
export async function authModuleForContract(): Promise<readonly { readonly method: string; readonly path: string }[]> {
  const config = buildTestConfig(await createTestKeys());
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
    const stack = (module.router as unknown as { readonly stack: readonly RouteLayer[] }).stack;
    return stack.flatMap((layer) =>
      layer.route === undefined
        ? []
        : Object.keys(layer.route.methods).map((method) => ({ method: method.toLowerCase(), path: layer.route?.path ?? "" })),
    );
  } finally {
    await pool.end();
  }
}
