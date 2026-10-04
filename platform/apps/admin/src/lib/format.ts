import type { AlertStatus, ApprovalStatus, CaseStatus, Permission, Severity, StaffRole, StaffStatus, TransferStatus } from "./types";

/**
 * Affichage exact des montants (aucune virgule flottante : unités mineures
 * → décimal en texte → Intl) et libellés du back-office.
 */

const LOCALE = "fr-FR";

export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Unités mineures signées → décimal exact. */
export function minorToDecimal(amountMinor: string, digits: number): string {
  const match = /^(-?)(\d+)$/.exec(amountMinor);
  if (match === null) throw new Error(`montant invalide : ${amountMinor}`);
  const sign = match[1] ?? "";
  const magnitude = match[2] ?? "0";
  if (digits === 0) return `${sign}${magnitude.replace(/^0+(?=\d)/, "")}`;
  const padded = magnitude.padStart(digits + 1, "0");
  return `${sign}${padded.slice(0, -digits).replace(/^0+(?=\d)/, "")}.${padded.slice(-digits)}`;
}

/** Saisie décimale positive (virgule ou point) → unités mineures, ou null. */
export function decimalToMinor(value: string, digits: number): string | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(normalized);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  const minor = `${match[1] ?? "0"}${fraction.padEnd(digits, "0")}`.replace(/^0+(?=\d)/, "");
  return minor === "0" ? null : minor;
}

export function formatMoney(amountMinor: string, currency: string): string {
  const digits = currencyDigits(currency);
  const formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return formatter.format(minorToDecimal(amountMinor, digits) as Intl.StringNumericLiteral);
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return "—";
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "medium", timeZone: "Europe/Paris" }).format(new Date(iso));
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  support: "Support client",
  risk_manager: "Gestion des risques",
  super_admin: "Super administrateur",
};

export const STAFF_STATUS_LABELS: Readonly<Record<StaffStatus, string>> = {
  invited: "Invité",
  active: "Actif",
  suspended: "Suspendu",
  disabled: "Désactivé",
};

export const TRANSFER_STATUS_LABELS: Readonly<Record<TransferStatus, string>> = {
  created: "Créé",
  awaiting_funding: "En attente de paiement",
  funding_processing: "Paiement en confirmation",
  funded: "Payé",
  compliance_review: "Revue de conformité",
  payout_pending: "Versement en préparation",
  payout_processing: "Versement en cours",
  payout_failed: "Versement en échec",
  completed: "Livré",
  refund_pending: "Remboursement en cours",
  refunded: "Remboursé",
  cancelled: "Annulé",
};

export const ALERT_STATUS_LABELS: Readonly<Record<AlertStatus, string>> = {
  open: "Ouverte",
  under_review: "En revue",
  escalated: "Escaladée",
  closed_false_positive: "Close — faux positif",
  closed_confirmed: "Close — confirmée",
};

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  low: "Faible",
  medium: "Moyenne",
  high: "Élevée",
  critical: "Critique",
};

export const CASE_STATUS_LABELS: Readonly<Record<CaseStatus, string>> = {
  open: "Ouvert",
  investigating: "En enquête",
  sar_filed: "Déclaration transmise",
  closed: "Clos",
};

export const APPROVAL_STATUS_LABELS: Readonly<Record<ApprovalStatus, string>> = {
  pending: "En attente",
  approved: "Approuvée",
  rejected: "Refusée",
  expired: "Expirée",
  executed: "Exécutée",
};

export const ACTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  invite_admin: "Invitation d'un membre du personnel",
  grant_roles: "Attribution de rôles",
  reactivate_admin: "Réactivation d'un membre",
  update_admin_network: "Plages d'adresses autorisées",
  refund_transfer: "Remboursement d'un transfert",
  set_account_status: "Gel / dégel d'un compte du registre",
  ledger_adjustment: "Ajustement comptable",
  reverse_journal: "Contre-passation d'un journal",
  file_sar: "Déclaration de soupçon",
};

export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  "customers:read": "Consulter les clients",
  "customers:read_pii": "Déchiffrer les données personnelles",
  "customers:suspend": "Suspendre un client",
  "transfers:read": "Consulter les transferts",
  "transfers:hold": "Mettre un transfert en revue",
  "transfers:release": "Libérer un transfert",
  "transfers:refund": "Rembourser un transfert",
  "kyc:read": "Consulter les vérifications d'identité",
  "kyc:decide": "Décider d'une vérification",
  "aml:alerts:read": "Consulter les alertes LCB-FT",
  "aml:alerts:manage": "Traiter les alertes",
  "aml:cases:manage": "Gérer les dossiers d'enquête",
  "aml:sar:file": "Déclarer un soupçon",
  "ledger:read": "Consulter le registre",
  "ledger:freeze": "Geler un compte",
  "ledger:adjust": "Ajuster le registre",
  "routing:manage": "Gérer le routage",
  "pricing:manage": "Gérer la tarification",
  "countries:manage": "Gérer les pays",
  "admins:manage": "Gérer le personnel",
  "audit:read": "Consulter le journal d'audit",
  "approvals:decide": "Statuer sur les demandes",
};

export function label(labels: Readonly<Record<string, string>>, value: string): string {
  return labels[value] ?? value;
}
