/**
 * Messages présentés au personnel. Le détail fourni par l'API (en français,
 * sans donnée technique) est affiché en priorité : il précise la règle en
 * cause (double validation, état incompatible…). Le code reste visible pour
 * le support.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_CREDENTIALS: "Identifiants ou clé de sécurité refusés.",
  VERIFICATION_EXPIRED: "Cette étape a expiré. Recommencez.",
  RATE_LIMITED: "Trop de tentatives. Patientez quelques minutes.",
  FORBIDDEN: "Action non autorisée pour votre compte ou depuis ce réseau.",
  FOUR_EYES_VIOLATION: "Règle des quatre yeux : cette action exige un second membre habilité.",
  CONFLICT: "L'élément a changé entre-temps : rechargez la page.",
  NOT_FOUND: "Élément introuvable.",
  VALIDATION_FAILED: "Certaines informations sont invalides.",
  UNAUTHENTICATED: "Session expirée. Reconnectez-vous.",
  INSUFFICIENT_FUNDS: "Solde insuffisant sur un des comptes.",
  UNBALANCED_JOURNAL: "L'écriture n'est pas équilibrée (débits ≠ crédits par devise).",
  ACCOUNT_NOT_POSTABLE: "Un des comptes est gelé ou fermé.",
  CURRENCY_MISMATCH: "La devise ne correspond pas à celle du compte.",
  INVALID_REVERSAL: "Ce journal ne peut pas être contre-passé.",
  INVALID_STATUS_TRANSITION: "Transition d'état non autorisée.",
  INVALID_LEDGER_INPUT: "Écriture comptable invalide.",
  SERVICE_UNAVAILABLE: "Service momentanément indisponible. Réessayez.",
};

export function userMessage(code: string, detail: string | null = null): string {
  if (code === "INVALID_CREDENTIALS") return MESSAGES[code] ?? "Identifiants refusés.";
  return detail ?? MESSAGES[code] ?? `Erreur inattendue (${code}).`;
}
