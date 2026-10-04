import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../session/secure_store.dart';
import 'device_key_store.dart';

/// Message signé par la clé de l'appareil, identique à celui que l'API
/// reconstruit (deviceBinding.service.ts) :
///
///   "TPv1\n" + MÉTHODE + "\n" + chemin?requête + "\n" + horodatage (ms) + "\n"
///   + compteur + "\n" + base64url(SHA-256(corps brut))
Uint8List canonicalSigningMessage({
  required String method,
  required String pathWithQuery,
  required String timestamp,
  required String counter,
  required List<int> body,
}) {
  // base64url SANS remplissage, comme Buffer#toString('base64url') côté API.
  final bodyHash = base64UrlNoPad(sha256.convert(body).bytes);
  return Uint8List.fromList(utf8.encode('TPv1\n${method.toUpperCase()}\n$pathWithQuery\n$timestamp\n$counter\n$bodyHash'));
}

/// Liaison attestation ↔ clé : SHA-256(défi ‖ SHA-256(clé publique SPKI)).
Uint8List attestationClientDataHash(List<int> challenge, List<int> publicKeySpki) {
  final keyDigest = sha256.convert(publicKeySpki).bytes;
  return Uint8List.fromList(sha256.convert([...challenge, ...keyDigest]).bytes);
}

/// Base64url sans remplissage (format attendu par l'API pour la signature).
String base64UrlNoPad(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Produit les en-têtes X-Device-* d'une requête. Le compteur est strictement
/// croissant et persisté AVANT l'envoi (anti-rejeu côté API) ; les signatures
/// sont produites une à la fois pour garantir cet ordre.
class RequestSigner {
  RequestSigner({required this._keys, required this._store, DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  final DeviceKeyStore _keys;
  final SecureStore _store;
  final DateTime Function() _clock;
  Future<void> _queue = Future<void>.value();

  Future<Map<String, String>> sign({required String deviceId, required String method, required Uri uri, required List<int> body}) {
    final completer = Completer<Map<String, String>>();
    _queue = _queue.then((_) async {
      try {
        completer.complete(await _signNow(deviceId: deviceId, method: method, uri: uri, body: body));
      } catch (error, stack) {
        completer.completeError(error, stack);
      }
    });
    return completer.future;
  }

  Future<Map<String, String>> _signNow({required String deviceId, required String method, required Uri uri, required List<int> body}) async {
    final previous = int.tryParse(await _store.read(StoreKeys.deviceCounter) ?? '') ?? 0;
    final counter = (previous + 1).toString();
    await _store.write(StoreKeys.deviceCounter, counter);
    final timestamp = _clock().millisecondsSinceEpoch.toString();
    final pathWithQuery = uri.hasQuery ? '${uri.path}?${uri.query}' : uri.path;
    final signature = await _keys.sign(canonicalSigningMessage(method: method, pathWithQuery: pathWithQuery, timestamp: timestamp, counter: counter, body: body));
    return {
      'X-Device-Id': deviceId,
      'X-Device-Signature-Timestamp': timestamp,
      'X-Device-Counter': counter,
      'X-Device-Signature': base64UrlNoPad(signature),
    };
  }

  /// Nouvel appareil : le compteur repart de zéro avec la nouvelle clé.
  Future<void> resetCounter() => _store.delete(StoreKeys.deviceCounter);
}
