import { normalizeDecimalLiteral } from "../../../lib/money.js";
import { parseJsonPreservingNumbers, RateProviderError } from "./types.js";
import type { RateProvider, RateSet } from "./types.js";

/**
 * Fixer (APILayer) — https://api.apilayer.com/fixer/latest?base=USD
 * Clé transmise dans l'en-tête « apikey » (jamais dans l'URL). La base USD
 * exige une offre payante ; la réponse est refusée si la base diffère.
 */
export class FixerClient implements RateProvider {
  readonly name = "fixer" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchLatest(): Promise<RateSet> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.apilayer.com/fixer/latest?base=USD", {
        headers: { apikey: this.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error: unknown) {
      throw new RateProviderError(this.name, "fournisseur injoignable", { cause: error });
    }
    const body = parseJsonPreservingNumbers(await response.text()) as {
      success?: unknown;
      error?: { code?: unknown; type?: unknown; info?: unknown };
      base?: unknown;
      timestamp?: unknown;
      rates?: unknown;
    };
    if (!response.ok || body.success !== true) {
      const type = typeof body.error?.type === "string" ? body.error.type : "inconnue";
      throw new RateProviderError(this.name, `erreur HTTP ${response.status} (${type})`);
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
        // Taux nul ou illisible : ignoré.
      }
    }
    return { provider: this.name, base: "USD", timestamp: new Date(Number(body.timestamp) * 1000), rates };
  }
}
