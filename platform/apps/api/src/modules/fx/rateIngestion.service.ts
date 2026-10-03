import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { relativeDifferenceBps } from "../../lib/money.js";
import type { RateProvider, RateProviderName } from "./providers/types.js";

/**
 * Collecte des taux : appel du fournisseur, contrôles, stockage, traçabilité.
 *
 * Contrôles avant stockage :
 *   - horodatage plausible (ni futur, ni plus vieux que 24 h) ;
 *   - devise connue (ISO 4217 référencée) ;
 *   - variation par rapport au dernier taux du même fournisseur inférieure au
 *     seuil (une variation brutale signale une donnée corrompue ou un
 *     événement de marché exigeant une revue humaine) : sinon le taux est
 *     REJETÉ et une alerte « fx.rate_rejected » est émise.
 */

const MAX_TIMESTAMP_AGE_MS = 24 * 3600 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface IngestionResult {
  readonly provider: RateProviderName;
  readonly status: "succeeded" | "partially_rejected";
  readonly received: number;
  readonly stored: number;
  readonly rejected: readonly { readonly currency: string; readonly reason: string; readonly rate: string }[];
}

export class RateIngestionService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    private readonly maxJumpBps: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(provider: RateProvider): Promise<IngestionResult> {
    const startedAt = this.now();
    let set;
    try {
      set = await provider.fetchLatest();
      const age = startedAt.getTime() - set.timestamp.getTime();
      if (age > MAX_TIMESTAMP_AGE_MS) throw new Error(`taux trop anciens (${Math.round(age / 60_000)} min)`);
      if (-age > MAX_FUTURE_SKEW_MS) throw new Error("horodatage des taux dans le futur");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.pool.query(
        `INSERT INTO fx.rate_fetches (provider, started_at, finished_at, status, error_message)
         VALUES ($1, $2, clock_timestamp(), 'failed', $3)`,
        [provider.name, startedAt, message.slice(0, 2000)],
      );
      this.logger.error({ provider: provider.name, err: error }, "collecte des taux échouée");
      throw error;
    }

    const known = await this.pool.query<{ code: string }>("SELECT code FROM ref.currencies WHERE code = ANY($1::text[])", [[...set.rates.keys()]]);
    const knownCodes = new Set(known.rows.map((row) => row.code));
    const previous = await this.pool.query<{ currency: string; rate: string; recent: boolean }>(
      `SELECT currency, rate::text, age < interval '24 hours' AS recent FROM fx.latest_usd_rates WHERE provider = $1`,
      [provider.name],
    );
    const previousByCurrency = new Map(previous.rows.map((row) => [row.currency, row] as const));

    const accepted: [string, string][] = [];
    const rejected: { currency: string; reason: string; rate: string }[] = [];
    for (const [currency, rate] of set.rates) {
      if (currency === "USD" || !knownCodes.has(currency)) continue;
      const last = previousByCurrency.get(currency);
      if (last?.recent === true) {
        const jump = relativeDifferenceBps(rate, last.rate);
        if (jump > this.maxJumpBps) {
          rejected.push({ currency, rate, reason: `variation de ${jump} pb depuis ${last.rate}` });
          continue;
        }
      }
      accepted.push([currency, rate]);
    }

    const stored = await this.pool.query(
      `INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
       SELECT $1, 'USD', t.currency, t.rate::numeric, $2
         FROM unnest($3::text[], $4::text[]) AS t(currency, rate)
       ON CONFLICT (provider, base_currency, quote_currency, provider_timestamp) DO NOTHING`,
      [provider.name, set.timestamp, accepted.map(([currency]) => currency), accepted.map(([, rate]) => rate)],
    );
    const status = rejected.length === 0 ? "succeeded" : "partially_rejected";
    await this.pool.query(
      `INSERT INTO fx.rate_fetches (provider, started_at, finished_at, status, provider_timestamp, rates_received, rates_stored, rejected)
       VALUES ($1, $2, clock_timestamp(), $3, $4, $5, $6, $7::jsonb)`,
      [provider.name, startedAt, status, set.timestamp, set.rates.size, stored.rowCount ?? 0, JSON.stringify(rejected)],
    );
    if (rejected.length > 0) {
      this.logger.error({ provider: provider.name, rejected }, "taux rejetés par le contrôle de variation");
      await this.pool.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('fx', gen_random_uuid(), 'fx.rate_rejected', $1::jsonb, $2)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [JSON.stringify({ provider: provider.name, providerTimestamp: set.timestamp.toISOString(), rejected }), `fx.rate_rejected:${provider.name}:${set.timestamp.toISOString()}`],
      );
    }
    return { provider: provider.name, status, received: set.rates.size, stored: stored.rowCount ?? 0, rejected };
  }
}
