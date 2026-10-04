import { Redis } from "ioredis";
import type { Logger } from "pino";

/**
 * Client Redis (limitation de débit, caches courts). Pas de file d'attente
 * hors ligne : si Redis est indisponible, les appels échouent immédiatement
 * et les limiteurs basculent sur leur limiteur de secours en mémoire.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client.on("error", (error: Error) => {
    logger.error({ err: error }, "erreur Redis");
  });
  return client;
}

export async function checkRedis(client: Redis): Promise<void> {
  const reply: string = await client.ping();
  if (reply !== "PONG") throw new Error(`réponse Redis inattendue : ${reply}`);
}
