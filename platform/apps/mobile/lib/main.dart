import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/date_symbol_data_local.dart';

import 'src/app.dart';
import 'src/app_services.dart';
import 'src/config.dart';
import 'src/core/api/api_client.dart';
import 'src/core/lock/app_lock.dart';
import 'src/core/security/device_key_store.dart';
import 'src/core/security/request_signer.dart';
import 'src/core/session/secure_store.dart';
import 'src/core/session/session_manager.dart';
import 'src/data/api.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('fr_FR');

  final AppConfig config;
  try {
    config = AppConfig.fromEnvironment();
  } on ConfigurationError catch (error) {
    runApp(_ConfigurationErrorApp(error.message));
    return;
  }

  final store = PlatformSecureStore();
  final keys = MethodChannelDeviceKeyStore();
  final signer = RequestSigner(keys: keys, store: store);
  final api = ApiClient(baseUrl: config.apiBaseUrl, httpClient: http.Client(), signer: signer);
  final session = SessionManager(api: api, store: store, keys: keys, signer: signer, playIntegrityCloudProject: config.playIntegrityCloudProject);
  final services = AppServices(
    config: config,
    session: session,
    lock: AppLock(LocalDeviceAuthenticator()),
    store: store,
    auth: AuthApi(api, session),
    transfers: TransfersApi(api),
    recipients: RecipientsApi(api),
    wallet: WalletApi(api),
    kyc: KycApi(api),
    security: SecurityApi(api),
  );
  runApp(TransfertPlusApp(services: services));
  unawaited(session.restore());
}

class _ConfigurationErrorApp extends StatelessWidget {
  const _ConfigurationErrorApp(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(body: SafeArea(child: Padding(padding: const EdgeInsets.all(24), child: Text('Configuration invalide : $message')))),
      );
}
