import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../security/request_signer.dart';
import 'api_exception.dart';
import 'json.dart';

/// Source des identifiants de session, fournie par le gestionnaire de session.
abstract interface class SessionCredentials {
  /// Appareil de confiance de cette installation, s'il est enregistré.
  String? get deviceId;

  /// Jeton d'accès valide (renouvelé au besoin), ou null hors session.
  Future<String?> accessToken();

  /// L'API a refusé [rejectedToken] : renouvelle (une seule fois pour des
  /// appels simultanés) ; false si la session est terminée.
  Future<bool> renewAfterRejection(String rejectedToken);
}

enum HttpMethod { get, post, delete }

/// Client HTTP de l'API. Les mutations sensibles sont signées par la clé
/// matérielle de l'appareil ; le corps signé est exactement celui envoyé.
class ApiClient {
  ApiClient({required this.baseUrl, required http.Client httpClient, required this._signer, this.timeout = const Duration(seconds: 20)}) : _http = httpClient;

  final Uri baseUrl;
  final http.Client _http;
  final RequestSigner _signer;
  final Duration timeout;
  SessionCredentials? credentials;

  Future<Json?> send(
    HttpMethod method,
    String path, {
    Map<String, String>? query,
    Object? body,
    bool authenticated = true,
    bool signed = false,
    String? signingDeviceId,
    String? idempotencyKey,
  }) async {
    if (!path.startsWith('/v1/')) throw ArgumentError.value(path, 'path', 'chemin /v1/… attendu');
    final uri = baseUrl.replace(path: path, queryParameters: query == null || query.isEmpty ? null : query);
    final bytes = body == null ? const <int>[] : utf8.encode(jsonEncode(body));

    Future<http.Response> attempt(String? accessToken) async {
      final headers = <String, String>{'Accept': 'application/json', 'Accept-Language': 'fr'};
      if (body != null) headers['Content-Type'] = 'application/json';
      if (accessToken != null) headers['Authorization'] = 'Bearer $accessToken';
      if (idempotencyKey != null) headers['Idempotency-Key'] = idempotencyKey;
      if (signed) {
        final deviceId = signingDeviceId ?? credentials?.deviceId;
        if (deviceId == null) throw const ApiException(status: 401, code: 'DEVICE_SIGNATURE_INVALID', title: 'Appareil non enregistré');
        headers.addAll(await _signer.sign(deviceId: deviceId, method: method.name.toUpperCase(), uri: uri, body: bytes));
      }
      final request = http.Request(method.name.toUpperCase(), uri)
        ..headers.addAll(headers)
        ..followRedirects = false;
      if (bytes.isNotEmpty) request.bodyBytes = bytes;
      try {
        return await http.Response.fromStream(await _http.send(request).timeout(timeout));
      } on TimeoutException {
        throw const ApiException.unavailable('Le service ne répond pas.');
      } on http.ClientException {
        throw const ApiException.unavailable();
      }
    }

    String? token;
    if (authenticated) {
      token = await credentials?.accessToken();
      if (token == null) throw const ApiException(status: 401, code: 'UNAUTHENTICATED', title: 'Session expirée');
    }
    var response = await attempt(token);
    // Jeton refusé (révoqué, expiré entre-temps) : un renouvellement puis un seul nouvel essai.
    // Une mutation financière est rejouable sans risque grâce à sa clé d'idempotence.
    if (response.statusCode == 401 && authenticated && token != null && await (credentials?.renewAfterRejection(token) ?? Future.value(false))) {
      token = await credentials?.accessToken();
      if (token != null) response = await attempt(token);
    }
    return _decode(response);
  }

  Json? _decode(http.Response response) {
    if (response.statusCode == 204) return null;
    Object? payload;
    if (response.bodyBytes.isNotEmpty) {
      try {
        payload = jsonDecode(utf8.decode(response.bodyBytes));
      } on FormatException {
        throw const ApiException.unavailable('Réponse illisible du service.');
      }
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (payload == null) return null;
      if (payload is Map<String, Object?>) return payload;
      throw const ApiException.unavailable('Réponse inattendue du service.');
    }
    throw problemOf(response.statusCode, payload);
  }
}

/// Problème RFC 9457 → ApiException.
ApiException problemOf(int status, Object? payload) {
  if (payload is Map<String, Object?>) {
    final issues = <FieldIssue>[];
    final rawIssues = payload['issues'];
    if (rawIssues is List<Object?>) {
      for (final issue in rawIssues) {
        if (issue is Map<String, Object?> && issue['path'] is String && issue['message'] is String) {
          issues.add(FieldIssue(issue['path']! as String, issue['message']! as String));
        }
      }
    }
    final code = payload['code'];
    final title = payload['title'];
    final detail = payload['detail'];
    return ApiException(
      status: status,
      code: code is String ? code : (status >= 500 ? 'SERVICE_UNAVAILABLE' : 'UNKNOWN'),
      title: title is String ? title : 'Erreur',
      detail: detail is String ? detail : null,
      issues: issues,
    );
  }
  return ApiException(status: status, code: status >= 500 ? 'SERVICE_UNAVAILABLE' : 'UNKNOWN', title: 'Erreur');
}
