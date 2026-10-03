import type { Logger } from "pino";

import type { DatabasePool } from "../db/pool.js";
import type { Job } from "./scheduler.js";

/** Purge des clés d'idempotence HTTP et des défis d'authentification expirés. */
export class MaintenanceJob implements Job {
  readonly name = "maintenance-purge";

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    readonly intervalMs: number,
  ) {}

  async run(): Promise<void> {
    const keys = await this.pool.query<{ count: number }>("SELECT integrations.purge_expired_idempotency_keys() AS count");
    const challenges = await this.pool.query<{ count: number }>("SELECT identity.purge_expired_challenges() AS count");
    this.logger.info({ idempotencyKeys: keys.rows[0]?.count ?? 0, challenges: challenges.rows[0]?.count ?? 0 }, "purge effectuée");
  }
}
