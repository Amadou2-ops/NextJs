import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:transfertplus/src/core/api/api_client.dart';
import 'package:transfertplus/src/core/api/api_exception.dart';
import 'package:transfertplus/src/core/security/request_signer.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';
import 'package:transfertplus/src/core/session/session_manager.dart';
import 'package:transfertplus/src/data/api.dart';
import 'package:transfertplus/src/data/models.dart';

import 'support/fakes.dart';

const _device = '11111111-2222-4333-8444-555555555555';
const _user = '6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90';

Map<String, Object?> _authenticated({String refresh = 'rt_suivant', String access = 'jeton.acces', String? device = _device, Duration ttl = const Duration(minutes: 10)}) => {
      'status': 'authenticated',
      'userId': _user,
      'sessionId': '0b7a7c5e-3d21-4c8f-9a51-1f2e3d4c5b6a',
      'deviceId': device,
      'accessToken': access,
      'accessTokenExpiresAt': DateTime.now().add(ttl).toUtc().toIso8601String(),
      'refreshToken': refresh,
      'refreshTokenExpiresAt': DateTime.now().add(const Duration(days: 30)).toUtc().toIso8601String(),
    };

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Harness {
  _Harness(Future<http.Response> Function(http.Request request) handler) {
    client = MockClient((request) {
      requests.add(request);
      return handler(request);
    });
    signer = RequestSigner(keys: keys, store: store);
    api = ApiClient(baseUrl: Uri.parse('https://api.transfertplus.com'), httpClient: client, signer: signer, timeout: const Duration(seconds: 2));
    session = SessionManager(api: api, store: store, keys: keys, signer: signer, playIntegrityCloudProject: 42);
  }

  final store = MemoryStore();
  final keys = FakeKeyStore();
  final requests = <http.Request>[];
  late final MockClient client;
  late final RequestSigner signer;
  late final ApiClient api;
  late final SessionManager session;
}

void main() {
  test('nouvel appareil : défi, clé matérielle neuve, attestation liée à la clé, puis code', () async {
    final challenge = List.generate(32, (index) => 255 - index);
    final harness = _Harness((request) async {
      switch (request.url.path) {
        case '/v1/auth/device-challenges':
          return _json({'challengeId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'challenge': base64Url.encode(challenge).replaceAll('=', ''), 'expiresAt': '2030-01-01T00:00:00Z'}, 201);
        case '/v1/auth/login':
          return _json({'status': 'second_factor_required', 'loginChallengeId': 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'method': 'sms_otp', 'expiresAt': '2030-01-01T00:00:00Z'});
        case '/v1/auth/login/verify':
          return _json(_authenticated());
      }
      return _json({'code': 'NOT_FOUND'}, 404);
    });
    final auth = AuthApi(harness.api, harness.session);
    final outcome = await auth.login(phone: '+33612345678', password: 'mot-de-passe-solide');
    expect(outcome, isA<LoginSecondFactor>());

    final login = harness.requests.firstWhere((request) => request.url.path == '/v1/auth/login');
    expect(login.headers.containsKey('X-Device-Signature'), isFalse);
    final device = (jsonDecode(login.body) as Map<String, Object?>)['client']! as Map<String, Object?>;
    final registration = device['device']! as Map<String, Object?>;
    expect(registration['publicKey'], base64.encode(FakeKeyStore.spki));
    expect(registration['publicKeyAlgorithm'], 'ES256');
    expect(registration['platform'], 'android');
    expect((registration['attestation']! as Map<String, Object?>)['type'], 'play_integrity');
    // L'attestation porte exactement SHA-256(défi ‖ SHA-256(clé publique)).
    final expected = sha256.convert([...challenge, ...sha256.convert(FakeKeyStore.spki).bytes]).bytes;
    expect(harness.keys.attested.single, expected);

    await auth.verifyLogin(loginChallengeId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', code: '123456');
    expect(harness.session.status, SessionStatus.signedIn);
    expect(harness.session.deviceId, _device);
    expect(harness.store.values[StoreKeys.refreshToken], 'rt_suivant');
    expect(harness.store.values[StoreKeys.deviceId], _device);
  });

  test('appareil de confiance : connexion signée sans code, corps signé = corps envoyé', () async {
    final harness = _Harness((request) async => _json(_authenticated()));
    harness.keys.key = FakeKeyStore.spki;
    harness.store.values[StoreKeys.deviceId] = _device;
    await harness.session.restore();
    harness.requests.clear();
    await harness.session.signOut();
    harness.requests.clear();

    final outcome = await AuthApi(harness.api, harness.session).login(phone: '+33612345678', password: 'mot-de-passe-solide');
    expect(outcome, isA<LoginAuthenticated>());
    final login = harness.requests.single;
    expect(login.headers['X-Device-Id'], _device);
    final body = jsonDecode(login.body) as Map<String, Object?>;
    expect(body['client'], {'type': 'mobile', 'deviceId': _device});
    final signedMessage = utf8.decode(harness.keys.signed.last);
    final bodyHash = base64Url.encode(sha256.convert(login.bodyBytes).bytes).replaceAll('=', '');
    expect(signedMessage, endsWith('\n$bodyHash'));
    expect(signedMessage, startsWith('TPv1\nPOST\n/v1/auth/login\n${login.headers['X-Device-Signature-Timestamp']}\n${login.headers['X-Device-Counter']}\n'));
  });

  test('renouvellement signé, unique pour des appels simultanés (jeton à usage unique)', () async {
    var refreshes = 0;
    final harness = _Harness((request) async {
      if (request.url.path == '/v1/auth/token/refresh') {
        refreshes++;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return _json(_authenticated(refresh: 'rt_$refreshes', access: 'acces_$refreshes', ttl: refreshes == 1 ? const Duration(seconds: 30) : const Duration(minutes: 10)));
      }
      return _json({'wallets': <Object?>[]});
    });
    harness.keys.key = FakeKeyStore.spki;
    harness.store.values
      ..[StoreKeys.deviceId] = _device
      ..[StoreKeys.refreshToken] = 'rt_initial';
    await harness.session.restore();
    expect(refreshes, 1);
    final refresh = harness.requests.single;
    expect(refresh.headers['X-Device-Id'], _device);
    expect(jsonDecode(refresh.body), {'refreshToken': 'rt_initial'});

    // Jeton d'accès à moins de 60 s de l'expiration : un seul renouvellement pour 3 appels.
    final wallet = WalletApi(harness.api);
    await Future.wait([wallet.wallets(), wallet.wallets(), wallet.wallets()]);
    expect(refreshes, 2);
    final walletCalls = harness.requests.where((request) => request.url.path == '/v1/wallets');
    expect(walletCalls.map((request) => request.headers['Authorization']).toSet(), {'Bearer acces_2'});
    expect(harness.store.values[StoreKeys.refreshToken], 'rt_2');
  });

  test('jeton refusé : renouvellement puis nouvel essai ; session révoquée : déconnexion', () async {
    var walletCalls = 0;
    var refreshStatus = 200;
    final harness = _Harness((request) async {
      if (request.url.path == '/v1/auth/token/refresh') {
        return refreshStatus == 200 ? _json(_authenticated(access: 'acces_neuf')) : _json({'code': 'UNAUTHENTICATED'}, refreshStatus);
      }
      walletCalls++;
      return request.headers['Authorization'] == 'Bearer acces_neuf' ? _json({'wallets': <Object?>[]}) : _json({'code': 'UNAUTHENTICATED'}, 401);
    });
    await harness.session.adopt(AuthenticatedSession.fromJson(_authenticated(access: 'acces_revoque')));
    harness.keys.key = FakeKeyStore.spki;
    expect(await WalletApi(harness.api).wallets(), isEmpty);
    expect(walletCalls, 2);

    refreshStatus = 401;
    await harness.session.adopt(AuthenticatedSession.fromJson(_authenticated(access: 'acces_revoque_2')));
    await expectLater(WalletApi(harness.api).wallets(), throwsA(isA<ApiException>().having((error) => error.status, 'status', 401)));
    expect(harness.session.status, SessionStatus.signedOut);
    expect(harness.store.values.containsKey(StoreKeys.refreshToken), isFalse);
    // L'appareil reste de confiance après une simple fin de session.
    expect(harness.store.values[StoreKeys.deviceId], _device);
  });

  test('appareil révoqué côté API : oublié, puis réenregistré avec une nouvelle clé', () async {
    var logins = 0;
    final harness = _Harness((request) async {
      switch (request.url.path) {
        case '/v1/auth/login':
          logins++;
          if (logins == 1) return _json({'code': 'DEVICE_SIGNATURE_INVALID', 'title': 'Signature'}, 401);
          return _json({'status': 'second_factor_required', 'loginChallengeId': 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'method': 'totp', 'expiresAt': '2030-01-01T00:00:00Z'});
        case '/v1/auth/device-challenges':
          return _json({'challengeId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'challenge': base64Url.encode(List.filled(32, 7)), 'expiresAt': '2030-01-01T00:00:00Z'}, 201);
      }
      return _json({}, 404);
    });
    harness.keys.key = FakeKeyStore.spki;
    harness.store.values
      ..[StoreKeys.deviceId] = _device
      ..[StoreKeys.deviceCounter] = '99';
    await harness.session.restore();
    final outcome = await AuthApi(harness.api, harness.session).login(phone: '+33612345678', password: 'mot-de-passe-solide');
    expect(outcome, isA<LoginSecondFactor>().having((value) => value.method, 'method', SecondFactorMethod.totp));
    expect(harness.keys.created, 1);
    expect(harness.store.values.containsKey(StoreKeys.deviceId), isFalse);
    expect(harness.store.values.containsKey(StoreKeys.deviceCounter), isFalse);
    final second = jsonDecode(harness.requests.last.body) as Map<String, Object?>;
    expect((second['client']! as Map<String, Object?>).containsKey('device'), isTrue);
  });

  test('transfert : signé, clé d\'idempotence transmise, problème RFC 9457 traduit', () async {
    final harness = _Harness((request) async => _json({
          'code': 'KYC_LIMIT_EXCEEDED',
          'title': 'Plafond',
          'detail': 'Plafond atteint',
          'issues': [
            {'path': 'body.quoteId', 'message': 'devis expiré'},
          ],
        }, 403));
    harness.keys.key = FakeKeyStore.spki;
    await harness.session.adopt(AuthenticatedSession.fromJson(_authenticated()));
    final key = TransfersApi.newIdempotencyKey();
    expect(key, matches(RegExp(r'^mob-[0-9a-f-]{36}$')));
    final error = await TransfersApi(harness.api)
        .create(quoteId: 'q', recipientId: 'r', purposeCode: 'gift', idempotencyKey: key)
        .then<ApiException?>((_) => null, onError: (Object error) => error as ApiException);
    final request = harness.requests.single;
    expect(request.headers['Idempotency-Key'], key);
    expect(request.headers['X-Device-Signature'], isNotNull);
    expect(request.followRedirects, isFalse);
    expect(error!.userMessage, contains('plafonds'));
    expect(error.fieldError('quoteId'), 'devis expiré');
  });

  test('panne réseau et réponse illisible : erreur « service indisponible »', () async {
    final offline = _Harness((request) async => throw http.ClientException('hors ligne'));
    await expectLater(offline.api.send(HttpMethod.post, '/v1/auth/device-challenges', authenticated: false), throwsA(isA<ApiException>().having((error) => error.code, 'code', 'SERVICE_UNAVAILABLE')));
    final garbage = _Harness((request) async => http.Response('<html>', 502));
    await expectLater(garbage.api.send(HttpMethod.post, '/v1/auth/device-challenges', authenticated: false), throwsA(isA<ApiException>().having((error) => error.status, 'status', 503)));
    final slow = _Harness((request) => Completer<http.Response>().future);
    await expectLater(slow.api.send(HttpMethod.get, '/v1/auth/devices', authenticated: false), throwsA(isA<ApiException>().having((error) => error.code, 'code', 'SERVICE_UNAVAILABLE')));
    expect(() => offline.api.send(HttpMethod.get, '/autre'), throwsArgumentError);
  });
}
