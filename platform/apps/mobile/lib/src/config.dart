import 'package:flutter/foundation.dart';

/// Configuration fournie à la compilation (`--dart-define`), validée au
/// démarrage : une configuration invalide arrête l'application plutôt que de
/// la laisser fonctionner en mode dégradé.
///
///   API_BASE_URL                  origine de l'API (https, sans chemin)
///   PLAY_INTEGRITY_CLOUD_PROJECT  numéro du projet Google Cloud (Android)
///   SMILE_ID_PARTNER_ID           identifiant partenaire Smile ID
///   SMILE_ID_AUTH_TOKEN           jeton SDK Smile ID (portail partenaire)
///   SMILE_ID_SANDBOX              "true" pour l'environnement de test Smile ID
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.playIntegrityCloudProject,
    required this.smileIdPartnerId,
    required this.smileIdAuthToken,
    required this.smileIdSandbox,
  });

  final Uri apiBaseUrl;
  final int? playIntegrityCloudProject;
  final String? smileIdPartnerId;
  final String? smileIdAuthToken;
  final bool smileIdSandbox;

  bool get smileIdConfigured => smileIdPartnerId != null && smileIdAuthToken != null;

  /// Hôtes accessibles en clair uniquement en développement (émulateurs).
  static const Set<String> _localHosts = {'localhost', '127.0.0.1', '10.0.2.2'};

  static AppConfig fromEnvironment() => parse(
        apiBaseUrl: const String.fromEnvironment('API_BASE_URL'),
        playIntegrityCloudProject: const String.fromEnvironment('PLAY_INTEGRITY_CLOUD_PROJECT'),
        smileIdPartnerId: const String.fromEnvironment('SMILE_ID_PARTNER_ID'),
        smileIdAuthToken: const String.fromEnvironment('SMILE_ID_AUTH_TOKEN'),
        smileIdSandbox: const String.fromEnvironment('SMILE_ID_SANDBOX'),
        release: kReleaseMode,
      );

  static AppConfig parse({
    required String apiBaseUrl,
    required String playIntegrityCloudProject,
    required String smileIdPartnerId,
    required String smileIdAuthToken,
    required String smileIdSandbox,
    required bool release,
  }) {
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw const ConfigurationError('API_BASE_URL absente ou invalide (--dart-define=API_BASE_URL=https://…)');
    }
    // La signature d'appareil porte sur le chemin vu par l'API : aucun préfixe autorisé.
    if ((uri.path.isNotEmpty && uri.path != '/') || uri.hasQuery || uri.hasFragment || uri.userInfo.isNotEmpty) {
      throw const ConfigurationError('API_BASE_URL doit être une origine, sans chemin ni paramètres');
    }
    final local = _localHosts.contains(uri.host);
    if (uri.scheme != 'https' && (release || !local)) {
      throw const ConfigurationError('API_BASE_URL doit être en https (http toléré seulement en développement local)');
    }
    int? project;
    if (playIntegrityCloudProject.isNotEmpty) {
      project = int.tryParse(playIntegrityCloudProject);
      if (project == null || project <= 0) throw const ConfigurationError('PLAY_INTEGRITY_CLOUD_PROJECT doit être un numéro de projet');
    }
    if ((smileIdPartnerId.isEmpty) != (smileIdAuthToken.isEmpty)) {
      throw const ConfigurationError('SMILE_ID_PARTNER_ID et SMILE_ID_AUTH_TOKEN vont de pair');
    }
    if (smileIdSandbox.isNotEmpty && smileIdSandbox != 'true' && smileIdSandbox != 'false') {
      throw const ConfigurationError('SMILE_ID_SANDBOX vaut "true" ou "false"');
    }
    if (release && smileIdSandbox == 'true') {
      throw const ConfigurationError('Smile ID en environnement de test interdit dans une version de production');
    }
    return AppConfig(
      apiBaseUrl: Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null),
      playIntegrityCloudProject: project,
      smileIdPartnerId: smileIdPartnerId.isEmpty ? null : smileIdPartnerId,
      smileIdAuthToken: smileIdAuthToken.isEmpty ? null : smileIdAuthToken,
      smileIdSandbox: smileIdSandbox == 'true',
    );
  }
}

class ConfigurationError implements Exception {
  const ConfigurationError(this.message);

  final String message;

  @override
  String toString() => 'Configuration invalide : $message';
}
