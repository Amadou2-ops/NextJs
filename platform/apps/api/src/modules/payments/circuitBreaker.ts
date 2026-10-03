import type { DatabasePool } from "../../db/pool.js";
import { PaymentProviderError } from "./providers/types.js";
import type { PaymentProviderName } from "./providers/types.js";

/**
 * Disjoncteur par prestataire (payments.provider_health), partagé par tous
 * les processus via la base :
 *   - fermé : appels normaux ; N échecs techniques consécutifs l'ouvrent ;
 *   - ouvert : le routage écarte le prestataire jusqu'à next_probe_at ;
 *   - semi-ouvert : un seul appel de sonde est autorisé (réservation
 *     atomique) ; son succès referme le disjoncteur, son échec le rouvre.
 * Un refus métier (carte refusée, compte invalide) n'est pas un échec
 * technique : le prestataire a répondu.
 */

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly openSeconds: number;
}

export class CircuitBreaker {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CircuitBreakerOptions,
  ) {}

  /** Le prestataire peut-il être appelé maintenant (réserve la sonde si semi-ouvert) ? */
  async canUse(provider: PaymentProviderName): Promise<boolean> {
    const health = await this.pool.query<{ circuit_state: string; probe_due: boolean }>(
      `SELECT circuit_state::text, COALESCE(next_probe_at <= now(), true) AS probe_due
         FROM payments.provider_health WHERE provider = $1::payments.provider`,
      [provider],
    );
    const row = health.rows[0];
    if (row === undefined) return false;
    if (row.circuit_state === "closed") return true;
    if (!row.probe_due) return false;
    const claimed = await this.pool.query(
      `UPDATE payments.provider_health
          SET circuit_state = 'half_open', next_probe_at = now() + make_interval(secs => $2)
        WHERE provider = $1::payments.provider AND circuit_state <> 'closed' AND next_probe_at <= now()
        RETURNING 1`,
      [provider, this.options.openSeconds],
    );
    return claimed.rowCount === 1;
  }

  /** Exécute un appel prestataire et enregistre son issue technique. */
  async run<T>(provider: PaymentProviderName, call: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await call();
      await this.record(provider, true, performance.now() - startedAt);
      return result;
    } catch (error: unknown) {
      const technical = !(error instanceof PaymentProviderError) || error.retryable || error.outcomeUnknown;
      await this.record(provider, !technical, performance.now() - startedAt);
      throw error;
    }
  }

  private async record(provider: PaymentProviderName, success: boolean, latencyMs: number): Promise<void> {
    const latency = Math.max(0, Math.round(latencyMs));
    if (success) {
      await this.pool.query(
        `UPDATE payments.provider_health
            SET circuit_state = 'closed', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL,
                window_started_at = CASE WHEN window_started_at < now() - interval '1 hour' THEN now() ELSE window_started_at END,
                success_count = CASE WHEN window_started_at < now() - interval '1 hour' THEN 1 ELSE success_count + 1 END,
                failure_count = CASE WHEN window_started_at < now() - interval '1 hour' THEN 0 ELSE failure_count END,
                avg_latency_ms = (avg_latency_ms * 9 + $2) / 10
          WHERE provider = $1::payments.provider`,
        [provider, latency],
      );
      return;
    }
    await this.pool.query(
      `UPDATE payments.provider_health h
          SET consecutive_failures = h.consecutive_failures + 1,
              window_started_at = CASE WHEN h.window_started_at < now() - interval '1 hour' THEN now() ELSE h.window_started_at END,
              success_count = CASE WHEN h.window_started_at < now() - interval '1 hour' THEN 0 ELSE h.success_count END,
              failure_count = CASE WHEN h.window_started_at < now() - interval '1 hour' THEN 1 ELSE h.failure_count + 1 END,
              avg_latency_ms = (h.avg_latency_ms * 9 + $2) / 10,
              circuit_state = CASE WHEN h.circuit_state <> 'closed' OR h.consecutive_failures + 1 >= $3
                                   THEN 'open'::payments.circuit_state ELSE 'closed'::payments.circuit_state END,
              opened_at = CASE WHEN h.circuit_state <> 'closed' OR h.consecutive_failures + 1 >= $3 THEN now() ELSE NULL END,
              next_probe_at = CASE WHEN h.circuit_state <> 'closed' OR h.consecutive_failures + 1 >= $3
                                   THEN now() + make_interval(secs => $4) ELSE NULL END
        WHERE h.provider = $1::payments.provider`,
      [provider, latency, this.options.failureThreshold, this.options.openSeconds],
    );
  }
}
