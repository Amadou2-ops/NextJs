import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import type { CustomerNotifier, NotificationOutcome } from "./customerNotifier.js";
import { definitionOf, loggablePayload } from "./eventCatalog.js";

/**
 * Consommateur de l'outbox transactionnelle (integrations.outbox).
 *
 * Chaque événement réservé (claim_outbox_batch : SKIP LOCKED, bail, essais
 * comptés) est :
 *   1. journalisé pour l'exploitation (gravité du catalogue ; charge utile
 *      réduite aux identifiants et codes) ;
 *   2. notifié au client lorsqu'il s'agit d'une issue de transfert ou de
 *      vérification d'identité ;
 *   3. publié, ou reprogrammé avec un délai croissant (1, 2, 4… minutes,
 *      plafonné à 1 h), puis abandonné (« dead ») au nombre maximal d'essais.
 *
 * Un worker tombé laisse ses réservations expirer : elles sont reprises, ou
 * abandonnées si elles avaient atteint le dernier essai.
 */

interface OutboxRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly max_attempts: number;
}

export interface DispatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly dead: number;
  readonly notified: number;
}

const MAX_BACKOFF_SECONDS = 3600;
const LEASE = "2 minutes";

export function retryDelaySeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.max(0, Math.min(attempts - 1, 12)));
}

export class OutboxDispatcher {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly logger: Logger;
      readonly notifier: CustomerNotifier;
      readonly workerId: string;
    },
  ) {}

  async dispatchBatch(batchSize: number): Promise<DispatchResult> {
    const buried = await this.buryAbandonedLeases();
    const claimed = await this.deps.pool.query<OutboxRow>(
      `SELECT id::text AS id, aggregate_type, aggregate_id, event_type, payload, attempts, max_attempts
         FROM integrations.claim_outbox_batch($1, $2, $3::interval)
        ORDER BY id`,
      [this.deps.workerId, batchSize, LEASE],
    );
    let published = 0;
    let retried = 0;
    let dead = buried;
    let notified = 0;
    for (const event of claimed.rows) {
      try {
        const outcome = await this.handle(event);
        if (outcome === "sent") notified += 1;
        await this.markPublished(event);
        published += 1;
      } catch (error: unknown) {
        if (await this.markFailed(event, error)) dead += 1;
        else retried += 1;
      }
    }
    return { claimed: claimed.rows.length, published, retried, dead, notified };
  }

  private async handle(event: OutboxRow): Promise<NotificationOutcome | "none"> {
    const definition = definitionOf(event.event_type);
    const entry = {
      outboxId: event.id,
      eventType: event.event_type,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      payload: loggablePayload(event.payload),
    };
    if (definition === undefined) {
      this.deps.logger.warn(entry, "événement de l'outbox non répertorié");
      return "none";
    }
    const log = definition.severity === "critical" ? this.deps.logger.error : definition.severity === "warning" ? this.deps.logger.warn : this.deps.logger.info;
    log.call(this.deps.logger, { ...entry, severity: definition.severity }, `événement ${event.event_type}`);
    if (definition.notify === undefined) return "none";
    return this.deps.notifier.notify({ id: event.id, aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, payload: event.payload }, definition.notify);
  }

  private async markPublished(event: OutboxRow): Promise<void> {
    await this.deps.pool.query(
      `UPDATE integrations.outbox
          SET status = 'published', published_at = now(), last_error = NULL, locked_by = NULL, locked_until = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
      [event.id, this.deps.workerId],
    );
  }

  /** Vrai si l'événement est abandonné (dernier essai). */
  private async markFailed(event: OutboxRow, error: unknown): Promise<boolean> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const exhausted = event.attempts >= event.max_attempts;
    await this.deps.pool.query(
      `UPDATE integrations.outbox
          SET status = $3::integrations.outbox_status, last_error = $4, locked_by = NULL, locked_until = NULL,
              available_at = now() + make_interval(secs => $5)
        WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
      [event.id, this.deps.workerId, exhausted ? "dead" : "failed", message, retryDelaySeconds(event.attempts)],
    );
    this.deps.logger[exhausted ? "error" : "warn"](
      { outboxId: event.id, eventType: event.event_type, attempts: event.attempts, err: error },
      exhausted ? "événement de l'outbox abandonné après le dernier essai : intervention requise" : "traitement d'un événement de l'outbox en échec, nouvel essai programmé",
    );
    return exhausted;
  }

  /** Réservations expirées au dernier essai (worker tombé) : abandonnées, jamais reprises. */
  private async buryAbandonedLeases(): Promise<number> {
    const result = await this.deps.pool.query<{ id: string; event_type: string }>(
      `UPDATE integrations.outbox
          SET status = 'dead', locked_by = NULL, locked_until = NULL,
              last_error = COALESCE(last_error, 'réservation expirée au dernier essai')
        WHERE status = 'processing' AND locked_until < now() AND attempts >= max_attempts
        RETURNING id::text AS id, event_type`,
    );
    for (const row of result.rows) {
      this.deps.logger.error({ outboxId: row.id, eventType: row.event_type }, "événement de l'outbox abandonné : réservation expirée au dernier essai");
    }
    return result.rows.length;
  }
}
