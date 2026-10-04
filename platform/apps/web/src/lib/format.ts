import type { FundingMethod, Money, PayoutMethod, TransferStatus } from "./types";

/**
 * Affichage des montants et libellés. Aucun calcul en virgule flottante : le
 * montant en unités mineures est converti en décimal exact (texte), puis mis
 * en forme par Intl, qui accepte une chaîne numérique sans perte.
 */

const LOCALE = "fr-FR";

/** Nombre de décimales d'une devise selon ISO 4217 (données Intl). */
export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function minorToDecimal(amountMinor: string, digits: number): string {
  if (!/^\d+$/.test(amountMinor)) throw new Error(`montant invalide : ${amountMinor}`);
  if (digits === 0) return amountMinor.replace(/^0+(?=\d)/, "");
  const padded = amountMinor.padStart(digits + 1, "0");
  return `${padded.slice(0, -digits).replace(/^0+(?=\d)/, "")}.${padded.slice(-digits)}`;
}

export function decimalToMinor(value: string, digits: number): string | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(normalized);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  const minor = `${match[1] ?? "0"}${fraction.padEnd(digits, "0")}`.replace(/^0+(?=\d)/, "");
  return minor === "0" ? null : minor;
}

export function formatMoney(money: Money): string {
  const digits = currencyDigits(money.currency);
  const formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency: money.currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return formatter.format(minorToDecimal(money.amount, digits) as Intl.StringNumericLiteral);
}

export function formatRate(rate: string, sourceCurrency: string, destinationCurrency: string): string {
  const [integer = "0", fraction = ""] = rate.split(".");
  const shown = fraction.length > 0 ? `${integer},${fraction.slice(0, 6).replace(/0+$/, "") || "0"}` : integer;
  return `1 ${sourceCurrency} = ${shown} ${destinationCurrency}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso));
}

export const TRANSFER_STATUS_LABELS: Readonly<Record<TransferStatus, string>> = {
  created: "Créé",
  awaiting_funding: "En attente de paiement",
  funding_processing: "Paiement en cours de confirmation",
  funded: "Payé",
  compliance_review: "Vérification en cours",
  payout_pending: "Envoi en préparation",
  payout_processing: "Envoi en cours",
  completed: "Livré",
  payout_failed: "Envoi en échec, nouvelle tentative",
  cancelled: "Annulé",
  refund_pending: "Remboursement en cours",
  refunded: "Remboursé",
};

export const PAYOUT_METHOD_LABELS: Readonly<Record<PayoutMethod, string>> = {
  mobile_money: "Mobile money",
  bank_account: "Compte bancaire",
  cash_pickup: "Retrait en espèces",
  card: "Carte bancaire",
  wallet: "Portefeuille",
};

export const FUNDING_METHOD_LABELS: Readonly<Record<FundingMethod, string>> = {
  wallet_balance: "Solde du portefeuille",
  card: "Carte bancaire",
  bank_transfer: "Virement bancaire",
  mobile_money: "Mobile money",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

export const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  family_support: "Soutien familial",
  education: "Études",
  medical_treatment: "Frais médicaux",
  gift: "Cadeau",
  household_expenses: "Dépenses du foyer",
  savings: "Épargne",
  travel: "Voyage",
  other: "Autre",
};

export const MOBILE_OPERATORS = [
  ["orange_money", "Orange Money"],
  ["wave", "Wave"],
  ["mtn_momo", "MTN MoMo"],
  ["moov_money", "Moov Money"],
  ["free_money", "Free Money"],
  ["mpesa", "M-Pesa"],
  ["airtel_money", "Airtel Money"],
  ["vodafone_cash", "Vodafone Cash"],
] as const;

/** Corridors proposés à l'envoi (destination, devise reçue, modes de réception). */
export const CORRIDORS = [
  { country: "SN", name: "Sénégal", currency: "XOF", payoutMethods: ["mobile_money", "bank_account", "cash_pickup"] },
  { country: "CI", name: "Côte d'Ivoire", currency: "XOF", payoutMethods: ["mobile_money", "bank_account", "cash_pickup"] },
  { country: "ML", name: "Mali", currency: "XOF", payoutMethods: ["mobile_money", "cash_pickup"] },
  { country: "BF", name: "Burkina Faso", currency: "XOF", payoutMethods: ["mobile_money", "cash_pickup"] },
  { country: "CM", name: "Cameroun", currency: "XAF", payoutMethods: ["mobile_money", "bank_account"] },
  { country: "MA", name: "Maroc", currency: "MAD", payoutMethods: ["bank_account", "cash_pickup"] },
  { country: "NG", name: "Nigeria", currency: "NGN", payoutMethods: ["bank_account", "mobile_money"] },
  { country: "GH", name: "Ghana", currency: "GHS", payoutMethods: ["mobile_money", "bank_account"] },
  { country: "KE", name: "Kenya", currency: "KES", payoutMethods: ["mobile_money", "bank_account"] },
] as const satisfies readonly { country: string; name: string; currency: string; payoutMethods: readonly PayoutMethod[] }[];

export const SENDING_COUNTRIES = [
  { country: "FR", name: "France", currency: "EUR" },
  { country: "BE", name: "Belgique", currency: "EUR" },
  { country: "ES", name: "Espagne", currency: "EUR" },
  { country: "IT", name: "Italie", currency: "EUR" },
  { country: "DE", name: "Allemagne", currency: "EUR" },
  { country: "GB", name: "Royaume-Uni", currency: "GBP" },
  { country: "US", name: "États-Unis", currency: "USD" },
  { country: "CA", name: "Canada", currency: "CAD" },
] as const;
