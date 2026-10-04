import { currencyDigits, decimalToMinor, minorToDecimal } from "./format";

/**
 * Paramétrage (marges, barèmes, corridors, encaissement, prestataires, pays) :
 * types des réponses de /v1/admin/configuration, libellés et conversions de
 * saisie. Les montants transitent en unités mineures ; les dates saisies sont
 * des heures de Paris, converties en instants exacts.
 */

export const PAYOUT_METHODS = ["bank_account", "mobile_money", "cash_pickup", "card", "wallet"] as const;
export const FUNDING_METHODS = ["wallet_balance", "card", "bank_transfer", "mobile_money", "apple_pay", "google_pay"] as const;
export const PAYIN_FUNDING_METHODS = ["card", "bank_transfer", "mobile_money", "apple_pay", "google_pay"] as const;
export const PROVIDERS = ["stripe", "flutterwave", "thunes"] as const;
export const RISK_LEVELS = ["low", "medium", "high", "prohibited"] as const;

export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export type FundingMethod = (typeof FUNDING_METHODS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type RuleState = "scheduled" | "active" | "ended";

interface Dated {
  readonly id: string;
  readonly priority: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly state: RuleState;
  readonly createdBy: { readonly id: string; readonly name: string } | null;
  readonly createdAt: string;
  readonly pendingRequestId: string | null;
}

export interface PricingRule extends Dated {
  readonly sourceCurrency: string | null;
  readonly destinationCurrency: string | null;
  readonly marginBps: number;
}

export interface FeeSchedule extends Dated {
  readonly sourceCountry: string | null;
  readonly destinationCountry: string | null;
  readonly sourceCurrency: string;
  readonly destinationCurrency: string | null;
  readonly payoutMethod: PayoutMethod | null;
  readonly fundingMethod: FundingMethod | null;
  readonly fixedFee: string;
  readonly percentageBps: number;
  readonly minFee: string;
  readonly maxFee: string | null;
}

export interface PayoutCorridor {
  readonly id: string;
  readonly sourceCountry: string | null;
  readonly destinationCountry: string;
  readonly destinationCurrency: string;
  readonly payoutMethod: PayoutMethod;
  readonly provider: Provider;
  readonly providerEnabled: boolean;
  readonly circuitState: string;
  readonly priority: number;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly costFixed: string;
  readonly costBps: number;
  readonly estimatedDeliveryMinutes: number;
  readonly isEnabled: boolean;
  readonly providerRouteCode: string | null;
  readonly updatedAt: string;
  readonly pendingRequestId: string | null;
}

export interface PayinMethod {
  readonly id: string;
  readonly country: string;
  readonly currency: string;
  readonly fundingMethod: FundingMethod;
  readonly provider: Provider;
  readonly providerEnabled: boolean;
  readonly circuitState: string;
  readonly priority: number;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly costFixed: string;
  readonly costBps: number;
  readonly isEnabled: boolean;
  readonly updatedAt: string;
  readonly pendingRequestId: string | null;
}

export interface PaymentProvider {
  readonly code: Provider;
  readonly displayName: string;
  readonly environment: "sandbox" | "live";
  readonly isEnabled: boolean;
  readonly supportsPayin: boolean;
  readonly supportsPayout: boolean;
  readonly circuitState: string;
  readonly updatedAt: string;
  readonly pendingRequestId: string | null;
}

export interface CountrySetting {
  readonly code: string;
  readonly name: string;
  readonly defaultCurrency: string | null;
  readonly riskLevel: RiskLevel;
  readonly canSend: boolean;
  readonly canReceive: boolean;
  readonly riskReviewedAt: string | null;
  readonly pendingRequestId: string | null;
}

export interface QuotePreview {
  readonly sendAmount: { readonly amount: string; readonly currency: string };
  readonly fee: { readonly amount: string; readonly currency: string };
  readonly totalToPay: { readonly amount: string; readonly currency: string };
  readonly receiveAmount: { readonly amount: string; readonly currency: string };
  readonly midRate: string;
  readonly customerRate: string;
  readonly marginBps: number;
  readonly pricingRuleId: string | null;
  readonly feeScheduleId: string;
  readonly estimatedDeliveryMinutes: number;
  readonly rateTimestamp: string | null;
}

export const PAYOUT_METHOD_LABELS: Readonly<Record<PayoutMethod, string>> = {
  bank_account: "Compte bancaire",
  mobile_money: "Mobile money",
  cash_pickup: "Retrait d'espèces",
  card: "Carte",
  wallet: "Portefeuille",
};

export const FUNDING_METHOD_LABELS: Readonly<Record<FundingMethod, string>> = {
  wallet_balance: "Solde du portefeuille",
  card: "Carte",
  bank_transfer: "Virement",
  mobile_money: "Mobile money",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = { stripe: "Stripe", flutterwave: "Flutterwave", thunes: "Thunes" };

export const RISK_LEVEL_LABELS: Readonly<Record<RiskLevel, string>> = { low: "Faible", medium: "Moyen", high: "Élevé", prohibited: "Interdit" };

export const RULE_STATE_LABELS: Readonly<Record<RuleState, string>> = { scheduled: "Programmée", active: "En vigueur", ended: "Terminée" };

export const CIRCUIT_LABELS: Readonly<Record<string, string>> = { closed: "Normal", open: "Coupé (échecs)", half_open: "En sonde" };

/** Points de base → pourcentage lisible (150 → « 1,50 % »). */
export function formatBps(bps: number): string {
  return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bps / 100)} %`;
}

/** Pourcentage saisi (« 1,5 ») → points de base entiers, ou null. */
export function percentToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Montant saisi dans une devise → unités mineures (0 accepté si autorisé). */
export function amountToMinor(value: string, currency: string, allowZero: boolean): string | null {
  const trimmed = value.trim();
  if (allowZero && /^0+(?:[.,]0+)?$/.test(trimmed)) return "0";
  return decimalToMinor(trimmed, currencyDigits(currency));
}

/** Unités mineures → saisie décimale (pré-remplissage des formulaires). */
export function minorToInput(amountMinor: string, currency: string): string {
  return minorToDecimal(amountMinor, currencyDigits(currency)).replace(".", ",");
}

const PARIS = "Europe/Paris";

function parisParts(instant: number): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PARIS,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const values: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = Number(part.value);
  return values;
}

/**
 * Heure de Paris saisie (« AAAA-MM-JJTHH:MM », champ datetime-local) →
 * instant ISO exact, changement d'heure compris ; null si la saisie est
 * invalide ou tombe dans l'heure sautée au printemps.
 */
export function parisLocalToIso(local: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wanted;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seen = parisParts(instant);
    const seenAsUtc = Date.UTC(seen["year"] ?? 0, (seen["month"] ?? 1) - 1, seen["day"] ?? 1, seen["hour"] ?? 0, seen["minute"] ?? 0);
    instant -= seenAsUtc - wanted;
  }
  const check = parisParts(instant);
  if (check["year"] !== year || check["month"] !== month || check["day"] !== day || check["hour"] !== hour || check["minute"] !== minute) return null;
  return new Date(instant).toISOString();
}

/** Périmètre d'une règle (null = « tous »). */
export function scope(value: string | null, all = "Tous"): string {
  return value ?? all;
}
