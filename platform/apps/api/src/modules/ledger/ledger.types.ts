/** Vocabulaire du registre, identique aux types énumérés de la base (0002). */

export const JOURNAL_TYPES = [
  "wallet_funding",
  "transfer_hold",
  "transfer_hold_release",
  "transfer_fee",
  "transfer_fx_conversion",
  "transfer_payout",
  "payout_settlement",
  "payout_failure",
  "refund",
  "chargeback",
  "provider_fee",
  "reversal",
  "adjustment",
  "capital_injection",
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const CUSTOMER_ACCOUNT_TYPES = ["customer_wallet", "customer_hold"] as const;
export type CustomerAccountType = (typeof CUSTOMER_ACCOUNT_TYPES)[number];

export const SYSTEM_ACCOUNT_TYPES = [
  "provider_settlement",
  "payin_clearing",
  "payout_clearing",
  "fx_position",
  "fee_revenue",
  "fx_revenue",
  "chargeback_loss",
  "provider_fee_expense",
  "suspense",
  "equity",
] as const;
export type SystemAccountType = (typeof SYSTEM_ACCOUNT_TYPES)[number];

/** Comptes système rattachés à un prestataire (la base l'impose aussi). */
export const PROVIDER_SCOPED_ACCOUNT_TYPES: ReadonlySet<SystemAccountType> = new Set([
  "provider_settlement",
  "payin_clearing",
  "payout_clearing",
  "provider_fee_expense",
]);

export type PaymentProvider = "stripe" | "flutterwave" | "thunes";
export type EntryDirection = "debit" | "credit";
