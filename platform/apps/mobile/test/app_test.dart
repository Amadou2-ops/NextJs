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

  testWidgets('mot de passe oublié : code SMS puis nouveau mot de passe, retour à la connexion', (tester) async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return switch (request.url.path) {
        '/v1/auth/password-reset/start' => http.Response(jsonEncode({'challengeId': '9b0c4a1e-6f61-4c3b-9d8e-1a2b3c4d5e6f', 'expiresAt': '2026-10-04T12:05:00Z'}), 202, headers: {'content-type': 'application/json'}),
        '/v1/auth/password-reset/complete' => http.Response('', 204),
        _ => http.Response('', 404),
      };
    });
    final services = _services(store: MemoryStore(), keys: FakeKeyStore(), authenticator: FakeAuthenticator(), client: client);
    await tester.pumpWidget(TransfertPlusApp(services: services));
    await services.session.restore();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Se connecter'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mot de passe oublié ?'));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextFormField, 'Numéro de téléphone du compte'), '+33612345678');
    await tester.tap(find.text('Recevoir un code par SMS'));
    await tester.pumpAndSettle();
    expect(jsonDecode(requests.last.body), {'phone': '+33612345678', 'countryHint': 'FR', 'locale': 'fr'});

    await tester.enterText(find.widgetWithText(TextFormField, 'Code reçu par SMS'), '123456');
    await tester.enterText(find.widgetWithText(TextFormField, 'Nouveau mot de passe (10 caractères au moins)'), 'Casamance-2027!');
    await tester.enterText(find.widgetWithText(TextFormField, 'Confirmation du mot de passe'), 'Casamance-2026!');
    await tester.tap(find.text('Changer mon mot de passe'));
    await tester.pumpAndSettle();
    expect(find.text('Les mots de passe ne correspondent pas'), findsOneWidget);
    expect(requests, hasLength(1));

    await tester.enterText(find.widgetWithText(TextFormField, 'Confirmation du mot de passe'), 'Casamance-2027!');
    await tester.tap(find.text('Changer mon mot de passe'));
    await tester.pumpAndSettle();
    expect(requests.last.url.path, '/v1/auth/password-reset/complete');
    expect(jsonDecode(requests.last.body), {
      'challengeId': '9b0c4a1e-6f61-4c3b-9d8e-1a2b3c4d5e6f',
      'code': '123456',
      'phone': '+33612345678',
      'countryHint': 'FR',
      'password': 'Casamance-2027!',
    });
    expect(find.text('Connexion'), findsOneWidget);
    expect(find.text('Mot de passe modifié. Connectez-vous avec le nouveau.'), findsOneWidget);
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

  testWidgets("ouverture d'un portefeuille : requête signée par la clé de l'appareil, accueil actualisé", (tester) async {
    final store = MemoryStore();
    final keys = FakeKeyStore()..key = FakeKeyStore.spki;
    store.values
      ..[StoreKeys.deviceId] = '11111111-2222-4333-8444-555555555555'
      ..[StoreKeys.refreshToken] = 'rt_initial';
    final wallets = <Map<String, Object?>>[];
    final opened = <http.Request>[];
    final client = MockClient((request) async {
      switch ('${request.method} ${request.url.path}') {
        case 'POST /v1/auth/token/refresh':
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
        case 'GET /v1/wallets':
          return http.Response(jsonEncode({'wallets': wallets}), 200);
        case 'POST /v1/wallets':
          opened.add(request);
          final wallet = {
            'currency': (jsonDecode(request.body) as Map<String, Object?>)['currency'],
            'available': {'amount': '0', 'currency': 'EUR'},
            'held': {'amount': '0', 'currency': 'EUR'},
          };
          wallets.add(wallet);
          return http.Response(jsonEncode(wallet), 201);
        case 'GET /v1/kyc':
          return http.Response(
            jsonEncode({
              'tier': 'tier_2',
              'limits': {'singleTransferMax': {'amount': '300000', 'currency': 'EUR'}, 'monthlyMax': {'amount': '1000000', 'currency': 'EUR'}},
              'nextTier': null,
              'attemptsRemaining': 3,
              'activeVerification': null,
            }),
            200,
          );
        case 'GET /v1/transfers':
          return http.Response(jsonEncode({'transfers': <Object?>[], 'nextCursor': null}), 200);
      }
      return http.Response(jsonEncode({'code': 'NOT_FOUND'}), 404);
    });
    final services = _services(store: store, keys: keys, authenticator: FakeAuthenticator(), client: client);
    await tester.pumpWidget(TransfertPlusApp(services: services));
    await services.session.restore();
    await tester.pumpAndSettle();

    expect(find.text('Aucun portefeuille ouvert.'), findsOneWidget);
    await tester.tap(find.text('Ouvrir un portefeuille'));
    await tester.pumpAndSettle();

    expect(opened, hasLength(1));
    expect(jsonDecode(opened.single.body), {'currency': 'EUR'});
    expect(opened.single.headers['X-Device-Id'], '11111111-2222-4333-8444-555555555555');
    expect(opened.single.headers['X-Device-Signature'], isNotEmpty);
    expect(keys.signed, isNotEmpty);
    expect(find.text('Aucun portefeuille ouvert.'), findsNothing);
    // L'EUR est ouvert : seules les autres devises restent proposées.
    expect(find.widgetWithText(DropdownButtonFormField<String>, 'GBP'), findsOneWidget);
  });
}
