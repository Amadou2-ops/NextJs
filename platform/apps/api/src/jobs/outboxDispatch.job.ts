import type { Logger } from "pino";

import type { OutboxDispatcher } from "../modules/notifications/outboxDispatcher.js";
import type { Job } from "./scheduler.js";

/**
 * Distribution de l'outbox : lots successifs jusqu'à épuisement (borné par
 * exécution, pour rendre la main au planificateur).
 */
export class OutboxDispatchJob implements Job {
  readonly name = "outbox-dispatch";

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly logger: Logger,
    readonly intervalMs: number,
    private readonly batchSize = 50,
    private readonly maxBatches = 20,
  ) {}

  async run(): Promise<void> {
    const totals = { claimed: 0, published: 0, retried: 0, dead: 0, notified: 0 };
    for (let batch = 0; batch < this.maxBatches; batch++) {
      const result = await this.dispatcher.dispatchBatch(this.batchSize);
      totals.claimed += result.claimed;
      totals.published += result.published;
      totals.retried += result.retried;
      totals.dead += result.dead;
      totals.notified += result.notified;
      if (result.claimed < this.batchSize) break;
    }
    if (totals.claimed + totals.dead > 0) this.logger.info(totals, "outbox distribuée");
    if (totals.dead > 0) throw new Error(`${totals.dead.toString()} événement(s) de l'outbox abandonné(s)`);
  }
}
