import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:transfertplus/src/app_services.dart';
import 'package:transfertplus/src/config.dart';
import 'package:transfertplus/src/core/api/api_client.dart';
import 'package:transfertplus/src/core/lock/app_lock.dart';
import 'package:transfertplus/src/core/security/device_key_store.dart';
import 'package:transfertplus/src/core/security/request_signer.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';
import 'package:transfertplus/src/core/session/session_manager.dart';
import 'package:transfertplus/src/data/api.dart';

/// Parcours mobile de bout en bout : l'application réelle (écrans, client
/// API, signature des requêtes, session) contre la pile réelle démarrée par
/// e2e/scripts/stack.ts (E2E_SUITE=mobile). Seuls les composants matériels
/// sont remplacés : composant sécurisé (service local, attestation App Attest
/// signée par une autorité de test que l'API n'accepte qu'en développement),
/// stockage sécurisé (mémoire) et biométrie (acceptée).

const String apiUrl = String.fromEnvironment('E2E_API_URL');
const String controlUrl = String.fromEnvironment('E2E_CONTROL_URL');

Map<String, Object?> _object(String body) {
  final decoded = jsonDecode(body);
  if (decoded is! Map<String, Object?>) throw FormatException('objet JSON attendu : $body');
  return decoded;
}

/// Service de contrôle de la pile (127.0.0.1).
class Control {
  Control() : _base = Uri.parse(controlUrl) {
    if (controlUrl.isEmpty || apiUrl.isEmpty) throw StateError('E2E_API_URL et E2E_CONTROL_URL requis (--dart-define)');
  }

  final Uri _base;
  final http.Client _client = http.Client();

  Future<Map<String, Object?>> call(String method, String path, {Map<String, Object?>? body, Map<String, String>? query}) async {
    final request = http.Request(method, _base.replace(path: path, queryParameters: query));
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await http.Response.fromStream(await _client.send(request));
    if (response.statusCode >= 400) throw StateError('contrôle $method $path : ${response.statusCode} ${response.body}');
    return response.body.isEmpty ? const {} : _object(response.body);
  }

  Future<int> smsCount(String phone) async => (await call('GET', '/control/sms-count', query: {'phone': phone}))['count']! as int;

  Future<String> smsCode(String phone, int seen) async => (await call('GET', '/control/sms-code', query: {'phone': phone, 'seen': '$seen'}))['code']! as String;

  Future<String> approveKyc(DateTime since) async =>
      (await call('POST', '/control/kyc/approve', body: {'since': since.toUtc().toIso8601String(), 'firstName': 'Aïssatou', 'lastName': 'Fall', 'dateOfBirth': '1990-02-14'}))['userId']! as String;

  Future<void> creditWallet(String userId, String currency, String amountMinor) =>
      call('POST', '/control/wallet/credit', body: {'userId': userId, 'currency': currency, 'amountMinor': amountMinor});
}

/// Composant sécurisé de l'appareil, hébergé par la pile de test.
class RemoteSecureElement implements DeviceKeyStore {
  RemoteSecureElement(this._control);

  final Control _control;

  Uint8List? _decode(Object? value) => value is String ? base64.decode(value) : null;

  @override
  Future<Uint8List> createKey() async => _decode((await _control.call('POST', '/secure-element/keys'))['publicKey'])!;

  @override
  Future<Uint8List?> publicKey() async => _decode((await _control.call('GET', '/secure-element/keys'))['publicKey']);

  @override
  Future<Uint8List> sign(Uint8List message) async => _decode((await _control.call('POST', '/secure-element/sign', body: {'message': base64.encode(message)}))['signature'])!;

  @override
  Future<void> deleteKey() => _control.call('DELETE', '/secure-element/keys');

  @override
  Future<AttestationEvidence> attest(Uint8List clientDataHash, {int? playIntegrityCloudProject}) async {
    final json = await _control.call('POST', '/secure-element/attest', body: {'clientDataHash': base64.encode(clientDataHash)});
    return AppAttestEvidence(keyId: json['keyId']! as String, attestationObject: json['attestationObject']! as String);
  }

  @override
  Future<DeviceDescription> describe() async => const DeviceDescription(platform: 'ios', name: 'iPhone de recette', osVersion: 'iOS 26.0', appVersion: '1.0.0');
}

/// Stockage sécurisé en mémoire, partagé entre deux lancements de l'application.
class MemorySecureStore implements SecureStore {
  final Map<String, String> values = {};

  @override
  Future<void> delete(String key) async => values.remove(key);

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

/// Biométrie acceptée ; les motifs demandés sont conservés pour vérification.
class AcceptingAuthenticator implements DeviceAuthenticator {
  final List<String> reasons = [];

  @override
  Future<bool> authenticate(String reason) async {
    reasons.add(reason);
    return true;
  }
}

/// Assemblage identique à lib/main.dart, avec les composants matériels de recette.
AppServices buildServices({required SecureStore store, required DeviceKeyStore keys, required DeviceAuthenticator authenticator}) {
  final config = AppConfig.parse(apiBaseUrl: apiUrl, playIntegrityCloudProject: '', smileIdPartnerId: '', smileIdAuthToken: '', smileIdSandbox: '', release: false);
  final signer = RequestSigner(keys: keys, store: store);
  final api = ApiClient(baseUrl: config.apiBaseUrl, httpClient: http.Client(), signer: signer);
  final session = SessionManager(api: api, store: store, keys: keys, signer: signer, playIntegrityCloudProject: null);
  return AppServices(
    config: config,
    session: session,
    lock: AppLock(authenticator),
    store: store,
    auth: AuthApi(api, session),
    transfers: TransfersApi(api),
    recipients: RecipientsApi(api),
    wallet: WalletApi(api),
    kyc: KycApi(api),
    security: SecurityApi(api),
  );
}

/// Laisse passer le temps réel (réseau, pile) et l'interface jusqu'à ce que
/// [finder] apparaisse. Les tests de widgets tournent en temps simulé : les
/// réponses réseau n'arrivent que pendant `runAsync`.
Future<void> pumpUntil(WidgetTester tester, Finder finder, {Duration timeout = const Duration(seconds: 30)}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump(const Duration(milliseconds: 50));
    if (finder.evaluate().isNotEmpty) return;
  }
  final visible = tester.widgetList<Text>(find.byType(Text)).map((text) => text.data ?? '').where((value) => value.isNotEmpty).join(' | ');
  throw TestFailure('Introuvable après ${timeout.inSeconds} s : $finder\nÀ l\'écran : $visible');
}

/// Appel réel (hors temps simulé) depuis le corps du test.
Future<T> real<T>(WidgetTester tester, Future<T> Function() action, {Duration timeout = const Duration(seconds: 30)}) async {
  final result = await tester.runAsync(() => action().timeout(timeout));
  return result as T;
}

/// Montant affiché (formatage français : espaces insécables).
Finder money(String amount) {
  final pattern = RegExp('^${RegExp.escape(amount).replaceAll(' ', r'\s')}\$');
  return find.byWidgetPredicate((widget) => widget is Text && widget.data != null && pattern.hasMatch(widget.data!), description: 'montant « $amount »');
}

/// Fait défiler l'écran courant jusqu'à [finder] (les listes ne construisent
/// que les éléments visibles), puis le rend visible.
Future<void> reveal(WidgetTester tester, Finder finder) async {
  // Défilement manuel : scrollUntilVisible attend la stabilisation, jamais
  // atteinte sur un écran à minuterie.
  for (var attempt = 0; attempt < 40 && finder.evaluate().isEmpty; attempt++) {
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -200), warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 100));
  }
  expect(finder, findsWidgets, reason: 'élément introuvable après défilement');
  await tester.ensureVisible(finder.first);
  await tester.pump(const Duration(milliseconds: 200));
}

/// Laisse l'interface terminer ses animations (menus, transitions). Les
/// écrans à minuterie (validité du devis) ne se « stabilisent » jamais :
/// `pumpAndSettle` y attendrait indéfiniment.
Future<void> settle(WidgetTester tester) async {
  for (var frame = 0; frame < 10; frame++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
