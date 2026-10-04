import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../data/models.dart';
import '../api/api_client.dart';
import '../api/api_exception.dart';
import '../api/json.dart';
import '../security/device_key_store.dart';
import '../security/request_signer.dart';
import 'secure_store.dart';

enum SessionStatus { unknown, signedOut, signedIn }

/// Session de l'utilisateur sur cet appareil.
///
/// - Jeton d'accès (10 min) en mémoire uniquement.
/// - Jeton de renouvellement (usage unique) dans le stockage sécurisé ; son
///   renouvellement est signé par la clé de l'appareil et dédupliqué : une
///   réutilisation révoquerait toute la session côté API.
/// - Appareil de confiance : identifiant conservé entre les sessions ; sa
///   clé matérielle sert de second facteur aux connexions suivantes.
class SessionManager extends ChangeNotifier implements SessionCredentials {
  SessionManager({required this._api, required this._store, required this._keys, required this._signer, required this._playIntegrityCloudProject}) {
    _api.credentials = this;
  }

  final ApiClient _api;
  final SecureStore _store;
  final DeviceKeyStore _keys;
  final RequestSigner _signer;
  final int? _playIntegrityCloudProject;

  SessionStatus _status = SessionStatus.unknown;
  String? _deviceId;
  String? _userId;
  String? _accessToken;
  DateTime? _accessTokenExpiresAt;
  Future<bool>? _renewal;

  SessionStatus get status => _status;
  String? get userId => _userId;

  @override
  String? get deviceId => _deviceId;

  /// Au démarrage : reprend la session si un jeton de renouvellement existe.
  Future<void> restore() async {
    _deviceId = await _store.read(StoreKeys.deviceId);
    if (_deviceId != null && await _keys.publicKey() == null) {
      // Clé matérielle disparue (restauration, réinitialisation) : appareil à réenregistrer.
      await _forgetDevice();
    }
    final refresh = await _store.read(StoreKeys.refreshToken);
    if (refresh == null || _deviceId == null) {
      await _setSignedOut();
      return;
    }
    _userId = await _store.read(StoreKeys.userId);
    try {
      if (!await _renew()) await _setSignedOut();
    } on ApiException catch (error) {
      if (error.status == 503) {
        // Hors ligne : la session reste ouverte, les écrans afficheront l'erreur.
        _status = SessionStatus.signedIn;
        notifyListeners();
        return;
      }
      await _setSignedOut();
    }
  }

  @override
  Future<String?> accessToken() async {
    if (_status != SessionStatus.signedIn) return null;
    final expiresAt = _accessTokenExpiresAt;
    if (_accessToken == null || expiresAt == null || expiresAt.difference(DateTime.now()) < const Duration(seconds: 60)) {
      if (!await _renewOnce()) return null;
    }
    return _accessToken;
  }

  @override
  Future<bool> renewAfterRejection(String rejectedToken) async {
    // Un autre appel a déjà renouvelé : rien à refaire.
    if (_accessToken != null && _accessToken != rejectedToken) return true;
    return _renewOnce();
  }

  Future<bool> _renewOnce() {
    final pending = _renewal;
    if (pending != null) return pending;
    final renewal = _renewSafely().whenComplete(() => _renewal = null);
    _renewal = renewal;
    return renewal;
  }

  Future<bool> _renewSafely() async {
    try {
      final renewed = await _renew();
      if (!renewed) await _setSignedOut();
      return renewed;
    } on ApiException catch (error) {
      if (error.status == 503) return false;
      await _setSignedOut();
      return false;
    }
  }

  Future<bool> _renew() async {
    final refresh = await _store.read(StoreKeys.refreshToken);
    final device = _deviceId;
    if (refresh == null || device == null) return false;
    try {
      final json = await _api.send(HttpMethod.post, '/v1/auth/token/refresh', body: {'refreshToken': refresh}, authenticated: false, signed: true, signingDeviceId: device);
      await adopt(AuthenticatedSession.fromJson(asObject(json)));
      return true;
    } on ApiException catch (error) {
      if (error.code == 'DEVICE_SIGNATURE_INVALID') await _forgetDevice();
      if (error.status == 401 || error.status == 403 || error.status == 400) return false;
      rethrow;
    }
  }

  /// Ouvre la session à partir de la réponse d'authentification.
  Future<void> adopt(AuthenticatedSession session) async {
    final device = session.deviceId;
    if (device == null) throw const FormatException('session mobile sans appareil');
    if (device != _deviceId) {
      _deviceId = device;
      await _store.write(StoreKeys.deviceId, device);
    }
    await _store.write(StoreKeys.refreshToken, session.refreshToken);
    await _store.write(StoreKeys.userId, session.userId);
    _userId = session.userId;
    _accessToken = session.accessToken;
    _accessTokenExpiresAt = session.accessTokenExpiresAt;
    if (_status != SessionStatus.signedIn) {
      _status = SessionStatus.signedIn;
      notifyListeners();
    }
  }

  /// Descripteur de client pour une connexion ou une inscription : appareil
  /// de confiance existant, sinon nouvel appareil attesté (clé neuve).
  Future<Map<String, Object?>> clientDescriptor() async {
    final known = _deviceId;
    if (known != null && await _keys.publicKey() != null) return {'type': 'mobile', 'deviceId': known};
    return {'type': 'mobile', 'device': await _newDeviceRegistration()};
  }

  Future<Map<String, Object?>> _newDeviceRegistration() async {
    final challengeJson = asObject(await _api.send(HttpMethod.post, '/v1/auth/device-challenges', authenticated: false));
    final challengeId = challengeJson.string('challengeId');
    final challenge = base64Url.decode(base64Url.normalize(challengeJson.string('challenge')));
    await _signer.resetCounter();
    final publicKey = await _keys.createKey();
    final evidence = await _keys.attest(attestationClientDataHash(challenge, publicKey), playIntegrityCloudProject: _playIntegrityCloudProject);
    final description = await _keys.describe();
    return {
      'challengeId': challengeId,
      'platform': description.platform,
      'name': description.name.length > 80 ? description.name.substring(0, 80) : description.name,
      'appVersion': description.appVersion,
      'osVersion': description.osVersion,
      'publicKey': base64.encode(publicKey),
      'publicKeyAlgorithm': 'ES256',
      'attestation': evidence.toJson(),
    };
  }

  /// Appareil inconnu de l'API (révoqué) : oubli local avant réenregistrement.
  Future<void> deviceRejected() => _forgetDevice();

  /// Compte clôturé par son titulaire : l'API a révoqué sessions et appareil ;
  /// secrets locaux et clé de l'appareil sont effacés.
  Future<void> accountClosed() async {
    await _forgetDevice();
    await _setSignedOut();
  }

  Future<void> signOut() async {
    if (_status == SessionStatus.signedIn) {
      try {
        await _api.send(HttpMethod.post, '/v1/auth/logout', signed: true);
      } on ApiException {
        // Session déjà expirée ou API injoignable : les secrets locaux sont effacés quoi qu'il arrive.
      }
    }
    await _setSignedOut();
  }

  Future<void> _setSignedOut() async {
    await _store.delete(StoreKeys.refreshToken);
    await _store.delete(StoreKeys.userId);
    _accessToken = null;
    _accessTokenExpiresAt = null;
    _userId = null;
    if (_status != SessionStatus.signedOut) {
      _status = SessionStatus.signedOut;
      notifyListeners();
    }
  }

  /// Appareil révoqué ou clé perdue : la prochaine connexion réenregistrera l'appareil.
  Future<void> _forgetDevice() async {
    _deviceId = null;
    await _store.delete(StoreKeys.deviceId);
    await _signer.resetCounter();
    try {
      await _keys.deleteKey();
    } on DeviceSecurityException {
      // Clé déjà absente.
    }
  }
}
