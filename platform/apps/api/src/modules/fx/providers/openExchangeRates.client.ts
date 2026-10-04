import { normalizeDecimalLiteral } from "../../../lib/money.js";
import { parseJsonPreservingNumbers, RateProviderError } from "./types.js";
import type { RateProvider, RateSet } from "./types.js";

/**
 * Open Exchange Rates — https://openexchangerates.org/api/latest.json
 * Authentification par en-tête « Authorization: Token <app_id> » (le secret
 * ne figure jamais dans l'URL, donc jamais dans les journaux des proxys).
 */
export class OpenExchangeRatesClient implements RateProvider {
  readonly name = "open_exchange_rates" as const;

  constructor(
    private readonly appId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchLatest(): Promise<RateSet> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://openexchangerates.org/api/latest.json?base=USD&show_alternative=false", {
        headers: { Authorization: `Token ${this.appId}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error: unknown) {
      throw new RateProviderError(this.name, "fournisseur injoignable", { cause: error });
    }
    const body = parseJsonPreservingNumbers(await response.text()) as {
      error?: unknown;
      message?: unknown;
      description?: unknown;
      base?: unknown;
      timestamp?: unknown;
      rates?: unknown;
    };
    if (!response.ok || body.error === true) {
      throw new RateProviderError(this.name, `erreur HTTP ${response.status} (${typeof body.message === "string" ? body.message : "inconnue"})`);
    }
    if (body.base !== "USD") throw new RateProviderError(this.name, `base inattendue : ${String(body.base)}`);
    if (typeof body.timestamp !== "string" || !/^\d{9,11}$/.test(body.timestamp)) throw new RateProviderError(this.name, "horodatage invalide");
    if (typeof body.rates !== "object" || body.rates === null) throw new RateProviderError(this.name, "taux absents");

    const rates = new Map<string, string>();
    for (const [currency, value] of Object.entries(body.rates as Record<string, unknown>)) {
      if (!/^[A-Z]{3}$/.test(currency) || typeof value !== "string") continue;
      try {
        rates.set(currency, normalizeDecimalLiteral(value));
      } catch {
        // Taux nul ou illisible : ignoré (journalisé par la collecte via l'absence).
      }
    }
    return { provider: this.name, base: "USD", timestamp: new Date(Number(body.timestamp) * 1000), rates };
  }
}
