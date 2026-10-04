import 'dart:typed_data';

import 'package:transfertplus/src/core/lock/app_lock.dart';
import 'package:transfertplus/src/core/security/device_key_store.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';

class MemoryStore implements SecureStore {
  final Map<String, String> values = {};

  @override
  Future<void> delete(String key) async => values.remove(key);

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

/// Composant sécurisé simulé pour les tests : enregistre les messages signés.
class FakeKeyStore implements DeviceKeyStore {
  Uint8List? key;
  final List<Uint8List> signed = [];
  final List<Uint8List> attested = [];
  int created = 0;

  static final Uint8List spki = Uint8List.fromList(List.generate(91, (index) => (index * 7) % 256));

  @override
  Future<Uint8List> createKey() async {
    created++;
    return key = spki;
  }

  @override
  Future<Uint8List?> publicKey() async => key;

  @override
  Future<Uint8List> sign(Uint8List message) async {
    if (key == null) throw const DeviceSecurityException('key_missing', 'absente');
    signed.add(message);
    // Taille d'une signature ECDSA P-256 DER.
    return Uint8List.fromList(List.filled(71, signed.length));
  }

  @override
  Future<void> deleteKey() async => key = null;

  @override
  Future<AttestationEvidence> attest(Uint8List clientDataHash, {int? playIntegrityCloudProject}) async {
    attested.add(clientDataHash);
    return PlayIntegrityEvidence('jeton.${'a' * 120}');
  }

  @override
  Future<DeviceDescription> describe() async => const DeviceDescription(platform: 'android', name: 'Google Pixel 9', osVersion: 'Android 16', appVersion: '1.0.0');
}

class FakeAuthenticator implements DeviceAuthenticator {
  bool answer = true;
  final List<String> reasons = [];

  @override
  Future<bool> authenticate(String reason) async {
    reasons.add(reason);
    return answer;
  }
}
