/// Erreur renvoyée par l'API (RFC 9457) ou panne réseau, traduite pour l'utilisateur.
class ApiException implements Exception {
  const ApiException({required this.status, required this.code, required this.title, this.detail, this.issues = const []});

  /// Service injoignable, délai dépassé ou réponse illisible.
  const ApiException.unavailable([this.detail])
      : status = 503,
        code = 'SERVICE_UNAVAILABLE',
        title = 'Service indisponible',
        issues = const [];

  final int status;
  final String code;
  final String title;
  final String? detail;
  final List<FieldIssue> issues;

  /// Message présenté à l'utilisateur (jamais de détail technique).
  String get userMessage => _messages[code] ?? detail ?? 'Une erreur est survenue. Réessayez ou contactez le service client.';

  /// Erreur de champ, sans le préfixe « body. ».
  String? fieldError(String field) {
    for (final issue in issues) {
      if (issue.path == 'body.$field' || issue.path == field) return issue.message;
    }
    return null;
  }

  @override
  String toString() => 'ApiException($status $code)';

  static const Map<String, String> _messages = {
    'INSUFFICIENT_FUNDS': 'Votre solde est insuffisant pour ce transfert.',
    'KYC_LIMIT_EXCEEDED': 'Ce montant dépasse vos plafonds actuels. Vérifiez votre identité pour les relever.',
    'COMPLIANCE_BLOCKED': 'Votre compte ne permet pas cette opération. Contactez le service client.',
    'QUOTE_EXPIRED_OR_CONSUMED': 'Ce devis a expiré. Nous avons besoin d\'un nouveau devis.',
    'INVALID_CREDENTIALS': 'Numéro de téléphone ou mot de passe incorrect.',
    'INVALID_VERIFICATION_CODE': 'Code incorrect. Vérifiez-le et réessayez.',
    'VERIFICATION_EXPIRED': 'Ce code a expiré. Recommencez l\'opération.',
    'ACCOUNT_LOCKED': 'Trop de tentatives. Votre compte est temporairement verrouillé. Vous pouvez réinitialiser votre mot de passe.',
    'ACCOUNT_DISABLED': 'Ce compte est suspendu ou clôturé. Contactez le service client.',
    'TOTP_REQUIRED': "Votre compte est protégé par une application d'authentification : demandez un nouveau code SMS et saisissez aussi le code de l'application.",
    'RATE_LIMITED': 'Trop de tentatives. Patientez quelques minutes avant de réessayer.',
    'VALIDATION_FAILED': 'Certaines informations sont invalides.',
    'CONFLICT': 'Cette opération entre en conflit avec une opération existante.',
    'IDEMPOTENCY_CONFLICT': 'Cette opération a déjà été enregistrée différemment. Recommencez.',
    'REQUEST_IN_PROGRESS': 'Votre demande est déjà en cours de traitement.',
    'NOT_FOUND': 'Élément introuvable.',
    'FORBIDDEN': 'Cette action n\'est pas autorisée.',
    'UNAUTHENTICATED': 'Votre session a expiré. Reconnectez-vous.',
    'DEVICE_SIGNATURE_INVALID': 'Cet appareil n\'est plus reconnu. Reconnectez-vous.',
    'DEVICE_ATTESTATION_FAILED': 'L\'authenticité de l\'application ou de l\'appareil n\'a pas pu être vérifiée.',
    'SERVICE_UNAVAILABLE': 'Service momentanément indisponible. Réessayez dans quelques instants.',
  };
}

class FieldIssue {
  const FieldIssue(this.path, this.message);

  final String path;
  final String message;
}
