import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:transfertplus/src/core/security/request_signer.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';

import 'support/fakes.dart';

/// Vecteurs produits par le code de l'API (deviceBinding.service.ts,
/// attestation/types.ts) : le message signé par l'application doit être
/// identique, octet pour octet, à celui que l'API reconstruit.
const _apiMessage =
    'VFB2MQpQT1NUCi92MS90cmFuc2ZlcnM/bGltaXQ9NSZiZWZvcmU9MjAyNi0xMC0wNFQwNSUzQTAwJTNBMDAuMDAwWgoxNzkwMDAwMDAwMDAwCjQyCjBabU5YZTc5Q3BtU3Jfb1ZkRGRqQlBHV2htVFNEZ0xQRGRHV2hOQ2dHYXM=';
const _apiEmptyMessage = 'VFB2MQpHRVQKL3YxL3dhbGxldHMKMTc5MDAwMDAwMDAwMQoxCjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlU=';
const _apiClientDataHash = '972f0e5f73a5d6901e02aad612893ed13b759230b3854d064d519ef93ed32297';

void main() {
  test('message canonique identique à celui de l\'API (requête encodée, corps UTF-8)', () {
    final body = utf8.encode(jsonEncode({
      'quoteId': '6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90',
      'recipientId': '0b7a7c5e-3d21-4c8f-9a51-1f2e3d4c5b6a',
      'purposeCode': 'family_support',
      'note': 'é€',
    }));
    final message = canonicalSigningMessage(
      method: 'post',
      pathWithQuery: '/v1/transfers?limit=5&before=2026-10-04T05%3A00%3A00.000Z',
      timestamp: '1790000000000',
      counter: '42',
      body: body,
    );
    expect(base64.encode(message), _apiMessage);
    expect(base64.encode(canonicalSigningMessage(method: 'GET', pathWithQuery: '/v1/wallets', timestamp: '1790000000001', counter: '1', body: const [])), _apiEmptyMessage);
  });

  test('condensat d\'attestation identique à celui de l\'API (défi ‖ empreinte de la clé)', () {
    final challenge = List.generate(32, (index) => index);
    expect(attestationClientDataHash(challenge, FakeKeyStore.spki).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join(), _apiClientDataHash);
  });

  test('en-têtes de signature : compteur strictement croissant, persisté, même sous concurrence', () async {
    final store = MemoryStore();
    final keys = FakeKeyStore()..key = FakeKeyStore.spki;
    final signer = RequestSigner(keys: keys, store: store, clock: () => DateTime.fromMillisecondsSinceEpoch(1790000000000));
    final uri = Uri.parse('https://api.transfertplus.com/v1/transfers?limit=5');
    final results = await Future.wait([for (var index = 0; index < 5; index++) signer.sign(deviceId: 'appareil', method: 'POST', uri: uri, body: utf8.encode('{}'))]);
    expect([for (final headers in results) headers['X-Device-Counter']], ['1', '2', '3', '4', '5']);
    expect(store.values[StoreKeys.deviceCounter], '5');
    final first = results.first;
    expect(first['X-Device-Id'], 'appareil');
    expect(first['X-Device-Signature-Timestamp'], '1790000000000');
    // base64url sans remplissage, dans les bornes acceptées par l'API.
    expect(first['X-Device-Signature'], matches(RegExp(r'^[A-Za-z0-9_-]{40,200}$')));
    expect(utf8.decode(keys.signed.first), startsWith('TPv1\nPOST\n/v1/transfers?limit=5\n1790000000000\n1\n'));

    await signer.resetCounter();
    final restarted = await signer.sign(deviceId: 'appareil', method: 'GET', uri: uri, body: const []);
    expect(restarted['X-Device-Counter'], '1');
  });

  test('base64url sans remplissage', () {
    expect(base64UrlNoPad(Uint8List.fromList([0xfb, 0xff])), '-_8');
  });
}
