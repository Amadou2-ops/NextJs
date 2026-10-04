/** Réponses de l'API du back-office (/v1/admin/*). Montants : chaînes en unités mineures. */

export const PERMISSIONS = [
  "customers:read",
  "customers:read_pii",
  "customers:suspend",
  "transfers:read",
  "transfers:hold",
  "transfers:release",
  "transfers:refund",
  "kyc:read",
  "kyc:decide",
  "aml:alerts:read",
  "aml:alerts:manage",
  "aml:cases:manage",
  "aml:sar:file",
  "ledger:read",
  "ledger:freeze",
  "ledger:adjust",
  "routing:manage",
  "pricing:manage",
  "countries:manage",
  "admins:manage",
  "audit:read",
  "approvals:decide",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ["support", "risk_manager", "super_admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type StaffStatus = "invited" | "active" | "suspended" | "disabled";

export interface StaffMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: StaffStatus;
  readonly roles: readonly StaffRole[];
  readonly allowedIpRanges: readonly string[];
  readonly securityKeys: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

export interface CurrentAdmin extends StaffMember {
  readonly permissions: readonly Permission[];
  readonly fourEyesPermissions: readonly Permission[];
}

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

// Clients ---------------------------------------------------------------------
export type CustomerStatus = "pending_verification" | "active" | "suspended" | "closed";

export interface CustomerSummary {
  readonly id: string;
  readonly customerNumber: string;
  readonly status: CustomerStatus;
  readonly kycTier: string;
  readonly countryOfResidence: string;
  readonly phoneCountry: string;
  readonly riskLevel: string | null;
  readonly createdAt: string;
}

export interface CustomerDetail extends CustomerSummary {
  readonly suspendedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly mfaEnabled: boolean;
  readonly emailVerified: boolean;
  readonly riskProfile: {
    readonly level: string;
    readonly score: number;
    readonly pep: boolean;
    readonly sanctioned: boolean;
    readonly enhancedDueDiligence: boolean;
    readonly factors: Readonly<Record<string, unknown>>;
    readonly assessedAt: string;
  } | null;
  readonly verifications: readonly {
    readonly id: string;
    readonly provider: string;
    readonly tier: string;
    readonly status: string;
    readonly manualDecision: boolean;
    readonly createdAt: string;
    readonly decidedAt: string | null;
    readonly expiresAt: string | null;
  }[];
  readonly wallets: readonly { readonly currency: string; readonly availableMinor: string; readonly heldMinor: string }[];
  readonly openAlerts: number;
  readonly transfers: { readonly total: number; readonly inReview: number };
  readonly cases: readonly { readonly id: string; readonly caseNumber: string; readonly status: string }[];
}

export interface CustomerPii {
  readonly phone: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly dateOfBirth: string | null;
}

// Transferts ------------------------------------------------------------------
export const TRANSFER_STATUSES = [
  "created",
  "awaiting_funding",
  "funding_processing",
  "funded",
  "compliance_review",
  "payout_pending",
  "payout_processing",
  "payout_failed",
  "completed",
  "refund_pending",
  "refunded",
  "cancelled",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export interface Actor {
  readonly type: string;
  readonly id: string | null;
}

export interface TransferSummary {
  readonly id: string;
  readonly reference: string;
  readonly userId: string;
  readonly status: TransferStatus;
  readonly statusReason: string | null;
  readonly corridor: { readonly from: string; readonly to: string };
  readonly send: Money;
  readonly fee: Money;
  readonly totalDebit: Money;
  readonly receive: Money;
  readonly usdEquivalentMinor: string;
  readonly fundingMethod: string;
  readonly payoutMethod: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferDetail extends TransferSummary {
  readonly history: readonly { readonly from: string | null; readonly to: string; readonly reason: string | null; readonly actor: Actor; readonly at: string }[];
  readonly attempts: readonly {
    readonly id: string;
    readonly direction: string;
    readonly provider: string;
    readonly status: string;
    readonly amountMinor: string;
    readonly currency: string;
    readonly providerReference: string | null;
    readonly failureCode: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly journals: readonly { readonly id: string; readonly seq: string; readonly type: string; readonly key: string; readonly reversesJournalId: string | null; readonly createdAt: string }[];
  readonly alerts: readonly { readonly id: string; readonly rule: string; readonly severity: string; readonly status: string; readonly createdAt: string; readonly resolvedAt: string | null }[];
  readonly amlEvaluation: { readonly outcome: string; readonly riskScore: number; readonly rules: unknown; readonly evaluatedAt: string } | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// KYC -------------------------------------------------------------------------
export interface KycVerification {
  readonly id: string;
  readonly userId: string;
  readonly customerNumber: string;
  readonly provider: string;
  readonly jobType: string;
  readonly tier: string;
  readonly status: string;
  readonly review: unknown;
  readonly reasons: readonly string[];
  readonly livenessScore: string | null;
  readonly documentMatchScore: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

export interface KycDetail extends KycVerification {
  readonly evidence: {
    readonly documentType: string | null;
    readonly issuingCountry: string | null;
    readonly declaredIdentityMatch: boolean | null;
    readonly documentSharedWithOtherCustomers: number;
    readonly identity: { readonly fullName: string | null; readonly dateOfBirth: string | null } | null;
  } | null;
  readonly history: readonly { readonly from: string | null; readonly to: string; readonly actor: Actor; readonly note: string | null; readonly at: string }[];
}

// AML -------------------------------------------------------------------------
export const ALERT_STATUSES = ["open", "under_review", "escalated", "closed_false_positive", "closed_confirmed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AmlAlert {
  readonly id: string;
  readonly userId: string;
  readonly customerNumber: string;
  readonly transferId: string | null;
  readonly transferReference: string | null;
  readonly rule: { readonly code: string; readonly description: string; readonly blocksTransfer: boolean };
  readonly severity: Severity;
  readonly score: number;
  readonly status: AlertStatus;
  readonly details: Readonly<Record<string, unknown>>;
  readonly assignee: { readonly id: string; readonly name: string } | null;
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface AmlAlertDetail extends AmlAlert {
  readonly screening: { readonly subject: string; readonly status: string; readonly lists: unknown; readonly matches: unknown; readonly screenedAt: string } | null;
}

export const CASE_STATUSES = ["open", "investigating", "sar_filed", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface AmlCaseSummary {
  readonly id: string;
  readonly caseNumber: string;
  readonly userId: string;
  readonly status: CaseStatus;
  readonly summary: string;
  readonly assignedTo: string | null;
  readonly alertCount: number;
  readonly createdAt: string;
}

export interface AmlCaseDetail {
  readonly id: string;
  readonly caseNumber: string;
  readonly userId: string;
  readonly status: CaseStatus;
  readonly summary: string;
  readonly openedBy: string;
  readonly assignedTo: string | null;
  readonly sarReference: string | null;
  readonly sarFiledAt: string | null;
  readonly closureNote: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly alerts: readonly AmlAlert[];
}

// Registre --------------------------------------------------------------------
/** Montant signé (les comptes techniques peuvent être négatifs). */
export interface SignedAmount {
  readonly amount: string;
  readonly currency: string;
}

export interface LedgerAccount {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly normalSide: "debit" | "credit";
  readonly currency: string;
  readonly ownerUserId: string | null;
  readonly provider: string | null;
  readonly status: string;
  readonly statusReason: string | null;
  readonly allowNegative: boolean;
  readonly balance: SignedAmount;
  readonly entryCount: string;
  readonly createdAt: string;
}

export interface LedgerEntries {
  readonly entries: readonly {
    readonly entryId: string;
    readonly sequence: string;
    readonly journalId: string;
    readonly journalType: string;
    readonly direction: "debit" | "credit";
    readonly amount: SignedAmount;
    readonly balanceAfter: SignedAmount;
    readonly description: string | null;
    readonly effectiveAt: string;
  }[];
  readonly nextCursor: string | null;
}

export interface LedgerJournal {
  readonly id: string;
  readonly sequence: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly reference: { readonly type: string; readonly id: string | null } | null;
  readonly reversesJournalId: string | null;
  readonly reversedByJournalId: string | null;
  readonly description: string | null;
  readonly metadata: unknown;
  readonly actor: unknown;
  readonly effectiveAt: string;
  readonly createdAt: string;
  readonly hash: string;
  readonly previousHash: string;
  readonly entries: readonly {
    readonly line: number;
    readonly accountId: string;
    readonly accountCode: string;
    readonly direction: "debit" | "credit";
    readonly amount: SignedAmount;
    readonly balanceAfter: SignedAmount;
  }[];
}

export interface TrialBalance {
  readonly currencies: readonly {
    readonly currency: string;
    readonly totalDebits: string;
    readonly totalCredits: string;
    readonly debitNormalBalances: string;
    readonly creditNormalBalances: string;
    readonly balanced: boolean;
  }[];
}

export interface LedgerIntegrity {
  readonly chainHead: { readonly sequence: string; readonly hash: string } | null;
  readonly lastReconciliation: {
    readonly id: string;
    readonly status: string;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly verifiedFromSequence: string | null;
    readonly verifiedToSequence: string | null;
    readonly problems: readonly unknown[];
  } | null;
  readonly lastAnchor: { readonly sequence: string; readonly hash: string; readonly target: string; readonly externalReference: string; readonly anchoredAt: string } | null;
}

// Approbations ----------------------------------------------------------------
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "executed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalActionType =
  | "invite_admin"
  | "grant_roles"
  | "reactivate_admin"
  | "update_admin_network"
  | "refund_transfer"
  | "set_account_status"
  | "ledger_adjustment"
  | "reverse_journal"
  | "file_sar";

export interface Approval {
  readonly id: string;
  readonly permission: string;
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly justification: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly requestedAt: string;
  readonly decidedBy: { readonly id: string; readonly name: string } | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly executedAt: string | null;
  readonly expiresAt: string;
}

export interface ApprovalOutcome {
  readonly approval: Approval;
  readonly result: Readonly<Record<string, unknown>>;
}

// Audit -----------------------------------------------------------------------
export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: Actor;
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string | null } | null;
  readonly ipAddress: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly hash: string;
}

export interface AuditIntegrity {
  readonly intact: boolean;
  readonly problems: readonly { readonly eventId: string; readonly problem: string }[];
  readonly lastEventId: string | null;
}
