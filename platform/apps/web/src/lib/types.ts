/**
 * Types des réponses de l'API (contrat packages/contracts/openapi.yaml).
 * Montants : entiers en unités mineures transmis en chaîne, jamais en nombre.
 */

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

/** Taux décimal exact (chaîne, 15 décimales au plus). */
export type ExchangeRate = string;

export type PayoutMethod = "bank_account" | "mobile_money" | "cash_pickup" | "card" | "wallet";
export type FundingMethod = "wallet_balance" | "card" | "bank_transfer" | "mobile_money" | "apple_pay" | "google_pay";
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

export interface Quote {
  readonly quoteId: string | null;
  readonly sourceCountry: string;
  readonly destinationCountry: string;
  readonly payoutMethod: PayoutMethod;
  readonly fundingMethod: FundingMethod;
  readonly sendAmount: Money;
  readonly fee: Money;
  readonly totalToPay: Money;
  readonly receiveAmount: Money;
  readonly exchangeRate: ExchangeRate;
  readonly estimatedDeliveryMinutes: number | null;
  readonly rateTimestamp: string | null;
  readonly expiresAt: string | null;
}

export interface Recipient {
  readonly id: string;
  readonly country: string;
  readonly currency: string;
  readonly payoutMethod: PayoutMethod;
  readonly firstName: string;
  readonly lastName: string;
  readonly displayHint: string;
  readonly mobileOperator: string | null;
  readonly relationship: string | null;
  readonly createdAt: string;
}

export interface Transfer {
  readonly id: string;
  readonly reference: string;
  readonly status: TransferStatus;
  readonly statusReason: string | null;
  readonly recipient: { readonly id: string; readonly displayHint: string };
  readonly sendAmount: Money;
  readonly fee: Money;
  readonly totalToPay: Money;
  readonly receiveAmount: Money;
  readonly exchangeRate: ExchangeRate;
  readonly fundingMethod: FundingMethod;
  readonly payoutMethod: PayoutMethod;
  readonly purposeCode: string;
  readonly createdAt: string;
  readonly fundedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly refundedAt: string | null;
}

export interface TransferDetail extends Transfer {
  readonly history: readonly { readonly status: TransferStatus; readonly at: string }[];
}

export type FundingAction =
  | { readonly type: "stripe_payment_intent"; readonly clientSecret: string; readonly publishableKey: string }
  | { readonly type: "redirect"; readonly url: string };

export interface CreatedTransfer {
  readonly transfer: Transfer;
  readonly funding: FundingAction | null;
}

export interface Wallet {
  readonly currency: string;
  readonly minorUnits: number;
  readonly available: Money;
  readonly held: Money;
}

export interface StatementEntry {
  readonly entryId: string;
  readonly sequence: string;
  readonly type: string;
  readonly direction: "in" | "out";
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly description: string;
  readonly isReversal: boolean;
  readonly effectiveAt: string;
}

export type KycTier = "tier_0" | "tier_1" | "tier_2" | "tier_3";

export interface KycVerification {
  readonly id: string;
  readonly tier: KycTier;
  readonly provider: "onfido" | "smile_id";
  readonly jobType: string;
  readonly status: "created" | "pending_submission" | "submitted" | "in_review" | "approved" | "rejected" | "resubmission_required" | "expired";
  readonly nextAction: "complete_capture" | "wait" | "retry" | "contact_support" | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly expiresAt: string | null;
}

export interface KycOverview {
  readonly tier: KycTier;
  readonly limits: { readonly singleTransferMax: Money; readonly dailyMax: Money; readonly monthlyMax: Money; readonly annualMax: Money };
  readonly nextTier: "tier_1" | "tier_2" | null;
  readonly declaredIdentity: boolean;
  readonly attemptsRemaining: number;
  readonly activeVerification: KycVerification | null;
  readonly verifications: readonly KycVerification[];
}

export type KycLaunch =
  | { readonly provider: "onfido"; readonly sdkToken: string; readonly workflowRunId: string }
  | {
      readonly provider: "smile_id";
      readonly partnerId: string;
      readonly environment: "sandbox" | "production";
      readonly jobId: string;
      readonly userId: string;
      readonly jobType: number;
      readonly product: string;
      readonly callbackUrl: string;
      readonly signature: string;
      readonly timestamp: string;
      readonly webToken: string | null;
    };

export interface SessionSummary {
  readonly id: string;
  readonly audience: "mobile" | "web";
  readonly deviceName: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly current: boolean;
}
