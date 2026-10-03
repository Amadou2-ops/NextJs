import type { FundingMethod, PaymentProviderName, PayoutMethod } from "../payments/providers/types.js";

export type TransferStatus =
  | "created"
  | "awaiting_funding"
  | "funding_processing"
  | "funded"
  | "compliance_review"
  | "payout_pending"
  | "payout_processing"
  | "completed"
  | "payout_failed"
  | "cancelled"
  | "refund_pending"
  | "refunded";

export type AttemptDirection = "payin" | "payout" | "refund";
export type StoredAttemptStatus = "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled" | "reversed";

/** Motifs de transfert proposés au client. */
export const PURPOSE_CODES = [
  "family_support",
  "education",
  "medical_treatment",
  "gift",
  "household_expenses",
  "savings",
  "travel",
  "other",
] as const;
export type PurposeCode = (typeof PURPOSE_CODES)[number];

export interface TransferRow {
  id: string;
  reference: string;
  user_id: string;
  recipient_id: string;
  quote_id: string;
  source_country: string;
  destination_country: string;
  source_currency: string;
  destination_currency: string;
  source_amount: bigint;
  fee_amount: bigint;
  total_debit: bigint;
  destination_amount: bigint;
  customer_rate: string;
  funding_method: FundingMethod;
  payout_method: PayoutMethod;
  purpose_code: string;
  status: TransferStatus;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
  funded_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  refunded_at: Date | null;
}

export const TRANSFER_COLUMNS = `t.id, t.reference, t.user_id, t.recipient_id, t.quote_id, t.source_country, t.destination_country,
  t.source_currency, t.destination_currency, t.source_amount, t.fee_amount, t.total_debit, t.destination_amount,
  t.customer_rate::text AS customer_rate, t.funding_method, t.payout_method, t.purpose_code, t.status, t.status_reason,
  t.created_at, t.updated_at, t.funded_at, t.completed_at, t.cancelled_at, t.refunded_at`;

export interface AttemptRow {
  id: string;
  transfer_id: string;
  direction: AttemptDirection;
  provider: PaymentProviderName;
  corridor_id: string | null;
  payin_method_id: string | null;
  idempotency_key: string;
  provider_reference: string | null;
  amount: bigint;
  currency: string;
  status: StoredAttemptStatus;
  provider_response: Record<string, unknown>;
  ledger_journal_id: string | null;
  created_at: Date;
}

export const ATTEMPT_COLUMNS = `a.id, a.transfer_id, a.direction, a.provider, a.corridor_id, a.payin_method_id, a.idempotency_key,
  a.provider_reference, a.amount, a.currency, a.status, a.provider_response, a.ledger_journal_id, a.created_at`;

export const ACTIVE_ATTEMPT_STATUSES: ReadonlySet<StoredAttemptStatus> = new Set(["pending", "requires_action", "processing"]);
