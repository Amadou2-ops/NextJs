import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";

/**
 * Boîte de réception des webhooks prestataires (integrations.webhook_events).
 *
 * Ordre imposé par les routes :
 *   1. vérification cryptographique sur le corps BRUT ; un échec est tracé
 *      dans webhook_rejections (empreinte et taille seulement) et refusé ;
 *   2. enregistrement de l'événement authentifié, une seule fois par
 *      identifiant prestataire (les renvois sont des doublons inoffensifs) ;
 *   3. accusé de réception immédiat, puis traitement par le gestionnaire de la
 *      source. Un échec de traitement est rejoué par le worker avec un délai
 *      croissant ; au-delà du nombre maximal de tentatives une alerte est
 *      émise (outbox) et l'événement attend une intervention humaine.
 *
 * Seule une charge minimisée (identifiants, statuts, codes) est conservée :
 * jamais de donnée personnelle brute en provenance d'un prestataire.
 */

export type WebhookSource = "stripe" | "flutterwave" | "thunes" | "smile_id" | "onfido";
export type WebhookRejectionReason = "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance" | "malformed_payload" | "unknown_source";

export interface StoredWebhookEvent {
  readonly id: string;
  readonly source: WebhookSource;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

export type WebhookHandlerResult = "processed" | "ignored";
export type WebhookHandler = (event: StoredWebhookEvent) => Promise<WebhookHandlerResult>;

export interface AcceptedWebhook {
  readonly eventId: string;
  readonly duplicate: boolean;
}

export interface WebhookInboxOptions {
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
}

const DEFAULT_OPTIONS: WebhookInboxOptions = { maxAttempts: 10, leaseSeconds: 120 };
const MAX_ERROR_LENGTH = 1000;

interface EventRow {
  id: string;
  source: WebhookSource;
  provider_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export class WebhookInbox {
  private readonly handlers = new Map<WebhookSource, WebhookHandler>();
  private readonly options: WebhookInboxOptions;

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    options: Partial<WebhookInboxOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1 || this.options.maxAttempts > 50) {
      throw new Error("maxAttempts doit être compris entre 1 et 50");
    }
  }

  register(source: WebhookSource, handler: WebhookHandler): void {
    if (this.handlers.has(source)) throw new Error(`gestionnaire déjà enregistré pour ${source}`);
    this.handlers.set(source, handler);
  }

  async recordRejection(params: {
    readonly source: string;
    readonly reason: WebhookRejectionReason;
    readonly ipAddress: string | undefined;
    readonly userAgent: string | undefined;
    readonly rawBody: Buffer;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO integrations.webhook_rejections (source, reason, ip_address, user_agent, body_sha256, body_size)
       VALUES ($1, $2::integrations.webhook_rejection_reason, $3::inet, $4, $5, $6)`,
      [
        params.source.slice(0, 50),
        params.reason,
        params.ipAddress ?? null,
        params.userAgent?.slice(0, 500) ?? null,
        createHash("sha256").update(params.rawBody).digest(),
        params.rawBody.length,
      ],
    );
  }

  async accept(params: {
    readonly source: WebhookSource;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly signedAt: Date | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly rawBody: Buffer;
  }): Promise<AcceptedWebhook> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO integrations.webhook_events (source, provider_event_id, event_type, signature_verified, signed_at,
                                                payload, payload_sha256)
       VALUES ($1::integrations.webhook_source, $2, $3, true, $4, $5::jsonb, $6)
       ON CONFLICT (source, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        params.source,
        params.providerEventId,
        params.eventType.slice(0, 200),
        params.signedAt,
        JSON.stringify(params.payload),
        createHash("sha256").update(params.rawBody).digest(),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { eventId: row.id, duplicate: false };
    const existing = await this.pool.query<{ id: string }>(
      "SELECT id FROM integrations.webhook_events WHERE source = $1::integrations.webhook_source AND provider_event_id = $2",
      [params.source, params.providerEventId],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) throw new Error("événement webhook introuvable après conflit");
    return { eventId: existingRow.id, duplicate: true };
  }

  /** Traite un événement s'il est disponible (non verrouillé, non terminé). */
  async process(eventId: string): Promise<WebhookHandlerResult | "skipped" | "failed"> {
    const claimed = await this.pool.query<EventRow>(
      `UPDATE integrations.webhook_events
          SET status = 'processing', attempts = attempts + 1, locked_until = now() + make_interval(secs => $3)
        WHERE id = $1
          AND attempts < $2
          AND (status IN ('received', 'failed') OR (status = 'processing' AND locked_until < now()))
          AND (locked_until IS NULL OR locked_until < now() OR status = 'received')
        RETURNING id, source, provider_event_id, event_type, payload, attempts`,
      [eventId, this.options.maxAttempts, this.options.leaseSeconds],
    );
    const row = claimed.rows[0];
    if (row === undefined) return "skipped";
    return this.run(row);
  }

  /** Reprise par le worker : événements reçus, en échec (délai écoulé) ou abandonnés en cours. */
  async processPending(limit: number): Promise<{ readonly processed: number; readonly failed: number }> {
    const claimed = await this.pool.query<EventRow>(
      `WITH candidates AS (
           SELECT e.id
             FROM integrations.webhook_events e
            WHERE e.attempts < $1
              AND (e.status = 'received'
                   OR (e.status = 'failed' AND (e.locked_until IS NULL OR e.locked_until < now()))
                   OR (e.status = 'processing' AND e.locked_until < now()))
            ORDER BY e.received_at
            LIMIT $2
              FOR UPDATE SKIP LOCKED
       )
       UPDATE integrations.webhook_events e
          SET status = 'processing', attempts = e.attempts + 1, locked_until = now() + make_interval(secs => $3)
         FROM candidates c
        WHERE e.id = c.id
       RETURNING e.id, e.source, e.provider_event_id, e.event_type, e.payload, e.attempts`,
      [this.options.maxAttempts, limit, this.options.leaseSeconds],
    );
    let processed = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      const outcome = await this.run(row);
      if (outcome === "failed") failed += 1;
      else processed += 1;
    }
    return { processed, failed };
  }

  private async run(row: EventRow): Promise<WebhookHandlerResult | "failed"> {
    const event: StoredWebhookEvent = {
      id: row.id,
      source: row.source,
      providerEventId: row.provider_event_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
    };
    const handler = this.handlers.get(event.source);
    try {
      if (handler === undefined) throw new Error(`aucun gestionnaire pour la source ${event.source}`);
      const result = await handler(event);
      await this.pool.query(
        `UPDATE integrations.webhook_events
            SET status = $2::integrations.webhook_status, processed_at = now(), locked_until = NULL, last_error = NULL
          WHERE id = $1`,
        [event.id, result],
      );
      return result;
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
      const exhausted = event.attempts >= this.options.maxAttempts;
      // Délai avant nouvelle tentative : 2^n minutes, plafonné à 1 h.
      const retryDelaySeconds = Math.min(3600, 60 * 2 ** Math.max(0, event.attempts - 1));
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE integrations.webhook_events
              SET status = 'failed', last_error = $2, locked_until = now() + make_interval(secs => $3)
            WHERE id = $1`,
          [event.id, message, retryDelaySeconds],
        );
        if (exhausted) {
          await client.query(
            `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
             VALUES ('webhook_event', $1, 'integrations.webhook_exhausted', $2::jsonb, $3)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [event.id, JSON.stringify({ source: event.source, event_type: event.eventType, attempts: event.attempts, last_error: message }), `webhook-exhausted:${event.id}`],
          );
        }
        await client.query("COMMIT");
      } catch (updateError: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        this.logger.error({ err: updateError, eventId: event.id }, "impossible d'enregistrer l'échec de traitement du webhook");
      } finally {
        client.release();
      }
      this.logger[exhausted ? "error" : "warn"](
        { eventId: event.id, source: event.source, attempts: event.attempts, err: error },
        exhausted ? "webhook en échec définitif : intervention requise" : "échec de traitement du webhook, nouvelle tentative programmée",
      );
      return "failed";
    }
  }
}

/** Identifiant de déduplication d'un événement sans identifiant prestataire : empreinte du corps brut. */
export function bodyEventId(rawBody: Buffer): string {
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}
