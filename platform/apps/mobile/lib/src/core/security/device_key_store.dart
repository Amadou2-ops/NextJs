import 'package:flutter/services.dart';

/// Clé de l'appareil, générée et conservée par le matériel (Secure Enclave
/// sur iOS, StrongBox ou TEE Android Keystore) : la clé privée ne quitte
/// jamais le composant sécurisé. Seule la clé publique (SPKI DER, P-256) est
/// exportée vers l'API.
abstract interface class DeviceKeyStore {
  /// Crée une nouvelle paire de clés (l'éventuelle précédente est détruite).
  Future<Uint8List> createKey();

  /// Clé publique SPKI DER de la clé existante, ou null.
  Future<Uint8List?> publicKey();

  /// Signature ECDSA P-256 / SHA-256 au format DER du message.
  Future<Uint8List> sign(Uint8List message);

  Future<void> deleteKey();

  /// Preuve d'authenticité de l'application et de l'appareil, liée au
  /// condensat [clientDataHash] (défi serveur ‖ empreinte de la clé publique).
  Future<AttestationEvidence> attest(Uint8List clientDataHash, {int? playIntegrityCloudProject});

  Future<DeviceDescription> describe();
}

sealed class AttestationEvidence {
  const AttestationEvidence();

  Map<String, Object?> toJson();
}

class AppAttestEvidence extends AttestationEvidence {
  const AppAttestEvidence({required this.keyId, required this.attestationObject});

  /// base64
  final String keyId;

  /// CBOR, base64
  final String attestationObject;

  @override
  Map<String, Object?> toJson() => {'type': 'app_attest', 'keyId': keyId, 'attestationObject': attestationObject};
}

class PlayIntegrityEvidence extends AttestationEvidence {
  const PlayIntegrityEvidence(this.integrityToken);

  final String integrityToken;

  @override
  Map<String, Object?> toJson() => {'type': 'play_integrity', 'integrityToken': integrityToken};
}

class DeviceDescription {
  const DeviceDescription({required this.platform, required this.name, required this.osVersion, required this.appVersion});

  /// "ios" ou "android"
  final String platform;
  final String name;
  final String osVersion;
  final String appVersion;
}

/// Erreur du composant sécurisé (clé indisponible, attestation refusée…).
class DeviceSecurityException implements Exception {
  const DeviceSecurityException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'DeviceSecurityException($code) $message';
}

/// Implémentation native (android/…/DeviceSecurityChannel.kt, ios/Runner/DeviceSecurityChannel.swift).
class MethodChannelDeviceKeyStore implements DeviceKeyStore {
  MethodChannelDeviceKeyStore([MethodChannel? channel]) : _channel = channel ?? const MethodChannel('com.transfertplus/device_security');

  final MethodChannel _channel;

  Future<T> _invoke<T>(String method, [Map<String, Object?>? arguments]) async {
    try {
      final result = await _channel.invokeMethod<T>(method, arguments);
      if (result == null) throw DeviceSecurityException('empty_result', 'réponse vide pour $method');
      return result;
    } on PlatformException catch (error) {
      throw DeviceSecurityException(error.code, error.message ?? 'erreur du composant sécurisé');
    }
  }

  @override
  Future<Uint8List> createKey() => _invoke<Uint8List>('createKey');

  @override
  Future<Uint8List?> publicKey() async {
    try {
      return await _channel.invokeMethod<Uint8List>('publicKey');
    } on PlatformException catch (error) {
      throw DeviceSecurityException(error.code, error.message ?? 'clé illisible');
    }
  }

  @override
  Future<Uint8List> sign(Uint8List message) => _invoke<Uint8List>('sign', {'message': message});

  @override
  Future<void> deleteKey() async {
    try {
      await _channel.invokeMethod<void>('deleteKey');
    } on PlatformException catch (error) {
      throw DeviceSecurityException(error.code, error.message ?? 'suppression impossible');
    }
  }

  @override
  Future<AttestationEvidence> attest(Uint8List clientDataHash, {int? playIntegrityCloudProject}) async {
    final result = await _invoke<Map<Object?, Object?>>('attest', {'clientDataHash': clientDataHash, 'cloudProjectNumber': playIntegrityCloudProject});
    switch (result['type']) {
      case 'app_attest':
        final keyId = result['keyId'];
        final object = result['attestationObject'];
        if (keyId is String && object is String) return AppAttestEvidence(keyId: keyId, attestationObject: object);
      case 'play_integrity':
        final token = result['integrityToken'];
        if (token is String) return PlayIntegrityEvidence(token);
    }
    throw const DeviceSecurityException('invalid_attestation', 'attestation native illisible');
  }

  @override
  Future<DeviceDescription> describe() async {
    final result = await _invoke<Map<Object?, Object?>>('describe');
    final platform = result['platform'];
    final name = result['name'];
    final osVersion = result['osVersion'];
    final appVersion = result['appVersion'];
    if (platform is! String || name is! String || osVersion is! String || appVersion is! String) {
      throw const DeviceSecurityException('invalid_description', 'description de l\'appareil illisible');
    }
    return DeviceDescription(platform: platform, name: name, osVersion: osVersion, appVersion: appVersion);
  }
}
