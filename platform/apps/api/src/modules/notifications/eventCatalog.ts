/**
 * Catalogue des événements de l'outbox : gravité pour le journal
 * d'exploitation et, pour quelques-uns seulement, modèle de notification du
 * client (issues de transferts et d'identité, avis de sécurité).
 *
 * Interdiction de divulgation (LCB-FT) : aucun événement de conformité (mise
 * en revue d'un transfert ou d'une identité, alerte, dossier, déclaration de
 * soupçon, criblage) n'a de modèle client. La base le garantit également
 * (integrations.customer_notifications_guard).
 */

export type EventSeverity = "critical" | "warning" | "info";

export type NotificationTemplate =
  | "transfer_completed"
  | "transfer_refunded"
  | "transfer_cancelled"
  | "kyc_approved"
  | "kyc_rejected"
  | "kyc_resubmission_required"
  | "password_changed";

export interface EventDefinition {
  readonly severity: EventSeverity;
  readonly notify?: NotificationTemplate;
}

const CRITICAL: EventDefinition = { severity: "critical" };
const WARNING: EventDefinition = { severity: "warning" };
const INFO: EventDefinition = { severity: "info" };

export const EVENT_CATALOG: Readonly<Record<string, EventDefinition>> = {
  // Intégrité et paiements : intervention immédiate.
  "ledger.integrity_breach": CRITICAL,
  "integrations.webhook_exhausted": CRITICAL,
  "aml.list_rejected": CRITICAL,
  "payments.payin_amount_mismatch": CRITICAL,
  "payments.payout_amount_mismatch": CRITICAL,
  "payments.refund_amount_mismatch": CRITICAL,
  "payments.refund_failed": CRITICAL,
  "payments.outcome_unknown": CRITICAL,
  "payments.payout_reversed_after_completion": CRITICAL,

  // À traiter dans la journée.
  "payments.float_insufficient": WARNING,
  "payments.late_payin": WARNING,
  "payments.payout_waiting": WARNING,
  "payments.fee_not_recorded": WARNING,
  "payments.dispute_funds_withdrawn": CRITICAL,
  "payments.dispute_funds_reinstated": INFO,
  "fx.rate_rejected": WARNING,
  "kyc.review_required": WARNING,
  "aml.alert_raised": WARNING,
  "aml.alert_escalated": WARNING,
  "aml.transfer_review_required": WARNING,
  "aml.sar_filed": INFO,
  "aml.alert_assigned": INFO,
  "aml.alert_resolved": INFO,
  "aml.case_opened": INFO,
  "aml.case_investigating": INFO,
  "aml.case_alerts_linked": INFO,
  "aml.case_closed": INFO,
  "aml.list_updated": INFO,
  "backoffice.approval_requested": INFO,
  "customers.password_reset": { severity: "info", notify: "password_changed" },
  "customers.closed": INFO,
  "customers.suspended": INFO,
  "customers.reactivated": INFO,

  // Cycle de vie des transferts et des vérifications d'identité.
  "transfers.created": INFO,
  "transfers.funded": INFO,
  "transfers.held_for_review": WARNING,
  "transfers.compliance_released": INFO,
  "transfers.refund_started": INFO,
  "transfers.completed": { severity: "info", notify: "transfer_completed" },
  "transfers.refunded": { severity: "info", notify: "transfer_refunded" },
  "transfers.cancelled": { severity: "info", notify: "transfer_cancelled" },
  "kyc.verification_approved": { severity: "info", notify: "kyc_approved" },
  "kyc.verification_rejected": { severity: "info", notify: "kyc_rejected" },
  "kyc.resubmission_required": { severity: "info", notify: "kyc_resubmission_required" },
};

/** Type inconnu du catalogue : journalisé en avertissement pour être répertorié. */
export function definitionOf(eventType: string): EventDefinition | undefined {
  return Object.hasOwn(EVENT_CATALOG, eventType) ? EVENT_CATALOG[eventType] : undefined;
}

const SAFE_TEXT = /^[A-Za-z0-9_.:@-]{1,80}$/;

/**
 * Charge utile réduite pour le journal : identifiants, codes et nombres
 * seulement. Les textes libres (motifs, messages d'erreur de prestataires,
 * noms) n'en sortent pas : ils restent consultables dans le back-office.
 */
export function loggablePayload(payload: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "string" && SAFE_TEXT.test(value)) result[key] = value;
  }
  return result;
}
