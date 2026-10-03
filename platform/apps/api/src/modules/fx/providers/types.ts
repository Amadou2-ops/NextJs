/**
 * Fournisseurs de taux de change. Tous les taux sont exprimés contre USD
 * (1 USD = taux unités de la devise) sous forme de décimaux EXACTS (chaînes)
 * lus depuis le texte JSON d'origine, jamais via un nombre flottant.
 */

export type RateProviderName = "open_exchange_rates" | "fixer";

export interface RateSet {
  readonly provider: RateProviderName;
  readonly base: "USD";
  readonly timestamp: Date;
  /** Code devise → taux décimal exact (≤ 15 décimales). */
  readonly rates: ReadonlyMap<string, string>;
}

export interface RateProvider {
  readonly name: RateProviderName;
  fetchLatest(): Promise<RateSet>;
}

export class RateProviderError extends Error {
  override readonly name = "RateProviderError";
  constructor(
    readonly provider: RateProviderName,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`${provider} : ${message}`, options);
  }
}

/** JSON.parse en conservant le texte source exact des nombres (Node ≥ 21). */
export function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? context.source : value,
  ) as unknown;
}
