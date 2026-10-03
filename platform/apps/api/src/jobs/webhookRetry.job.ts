import type { Logger } from "pino";

import type { WebhookInbox } from "../modules/webhooks/webhookInbox.js";
import type { Job } from "./scheduler.js";

/**
 * Reprise des webhooks reçus mais non traités (processus API arrêté entre
 * l'accusé de réception et le traitement) ou en échec (délai croissant).
 */
export class WebhookRetryJob implements Job {
  readonly name = "webhook-retry";

  constructor(
    private readonly inbox: WebhookInbox,
    private readonly logger: Logger,
    readonly intervalMs: number,
    private readonly batchSize = 100,
  ) {}

  async run(): Promise<void> {
    const result = await this.inbox.processPending(this.batchSize);
    if (result.processed + result.failed > 0) this.logger.info(result, "webhooks repris");
  }
}
