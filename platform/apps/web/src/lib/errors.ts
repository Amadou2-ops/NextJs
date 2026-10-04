/**
 * Messages présentés au client pour les codes d'erreur de l'API. Aucun
 * détail technique n'est affiché ; le code permet au support de retrouver
 * l'incident.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: "Votre solde est insuffisant pour ce transfert.",
  KYC_LIMIT_EXCEEDED: "Ce montant dépasse vos plafonds actuels. Vérifiez votre identité pour les relever.",
  COMPLIANCE_BLOCKED: "Votre compte ne permet pas cette opération. Contactez le service client.",
  QUOTE_EXPIRED_OR_CONSUMED: "Ce devis a expiré. Nous avons besoin d'un nouveau devis.",
  INVALID_CREDENTIALS: "Numéro de téléphone ou mot de passe incorrect.",
  INVALID_VERIFICATION_CODE: "Code incorrect. Vérifiez-le et réessayez.",
  VERIFICATION_EXPIRED: "Ce code a expiré. Recommencez l'opération.",
  ACCOUNT_LOCKED: "Trop de tentatives. Votre compte est temporairement verrouillé.",
  RATE_LIMITED: "Trop de tentatives. Patientez quelques minutes avant de réessayer.",
  VALIDATION_FAILED: "Certaines informations sont invalides.",
  CONFLICT: "Cette opération entre en conflit avec une opération existante.",
  IDEMPOTENCY_CONFLICT: "Cette opération a déjà été enregistrée différemment. Recommencez.",
  REQUEST_IN_PROGRESS: "Votre demande est déjà en cours de traitement.",
  NOT_FOUND: "Élément introuvable.",
  FORBIDDEN: "Cette action n'est pas autorisée.",
  UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
  SERVICE_UNAVAILABLE: "Service momentanément indisponible. Réessayez dans quelques instants.",
};

export function userMessage(code: string, detail: string | null = null): string {
  return MESSAGES[code] ?? detail ?? "Une erreur est survenue. Réessayez ou contactez le service client.";
}
