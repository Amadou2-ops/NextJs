import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:transfertplus/src/app.dart';
import 'package:transfertplus/src/app_services.dart';
import 'package:transfertplus/src/config.dart';
import 'package:transfertplus/src/core/api/api_client.dart';
import 'package:transfertplus/src/core/lock/app_lock.dart';
import 'package:transfertplus/src/core/security/request_signer.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';
import 'package:transfertplus/src/core/session/session_manager.dart';
import 'package:transfertplus/src/data/api.dart';

import 'support/fakes.dart';

AppServices _services({required MemoryStore store, required FakeKeyStore keys, required FakeAuthenticator authenticator, required MockClient client}) {
  final config = AppConfig.parse(apiBaseUrl: 'https://api.transfertplus.com', playIntegrityCloudProject: '', smileIdPartnerId: '', smileIdAuthToken: '', smileIdSandbox: '', release: true);
  final signer = RequestSigner(keys: keys, store: store);
  final api = ApiClient(baseUrl: config.apiBaseUrl, httpClient: client, signer: signer);
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

void main() {
  setUpAll(() => initializeDateFormatting('fr_FR'));

  testWidgets('sans session : écran de bienvenue, puis formulaire de connexion', (tester) async {
    final services = _services(store: MemoryStore(), keys: FakeKeyStore(), authenticator: FakeAuthenticator(), client: MockClient((request) async => http.Response('', 404)));
    await tester.pumpWidget(TransfertPlusApp(services: services));
    await services.session.restore();
    await tester.pumpAndSettle();
    expect(find.text('Créer un compte'), findsOneWidget);
    await tester.tap(find.text('Se connecter'));
    await tester.pumpAndSettle();
    expect(find.text('Connexion'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Mot de passe'), findsOneWidget);
  });

  testWidgets('session reprise : rien n\'est affiché avant le déverrouillage biométrique', (tester) async {
    final store = MemoryStore();
    final keys = FakeKeyStore()..key = FakeKeyStore.spki;
    store.values
      ..[StoreKeys.deviceId] = '11111111-2222-4333-8444-555555555555'
      ..[StoreKeys.refreshToken] = 'rt_initial';
    final authenticator = FakeAuthenticator()..answer = false;
    final client = MockClient((request) async {
      if (request.url.path == '/v1/auth/token/refresh') {
        return http.Response(
          jsonEncode({
            'status': 'authenticated',
            'userId': '6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90',
            'sessionId': '0b7a7c5e-3d21-4c8f-9a51-1f2e3d4c5b6a',
            'deviceId': '11111111-2222-4333-8444-555555555555',
            'accessToken': 'acces',
            'accessTokenExpiresAt': DateTime.now().add(const Duration(minutes: 10)).toUtc().toIso8601String(),
            'refreshToken': 'rt_suivant',
            'refreshTokenExpiresAt': DateTime.now().add(const Duration(days: 30)).toUtc().toIso8601String(),
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'code': 'NOT_FOUND'}), 404);
    });
    final services = _services(store: store, keys: keys, authenticator: authenticator, client: client);
    await tester.pumpWidget(TransfertPlusApp(services: services));
    await services.session.restore();
    await tester.pumpAndSettle();
    expect(services.session.status, SessionStatus.signedIn);
    expect(find.text('TransfertPlus est verrouillé'), findsOneWidget);
    expect(find.text('Portefeuilles'), findsNothing);
    expect(authenticator.reasons, contains('Déverrouillez TransfertPlus'));
  });
}
