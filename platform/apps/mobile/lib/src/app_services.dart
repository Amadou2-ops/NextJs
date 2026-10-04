import 'package:flutter/widgets.dart';

import 'config.dart';
import 'core/lock/app_lock.dart';
import 'core/session/secure_store.dart';
import 'core/session/session_manager.dart';
import 'data/api.dart';

/// Services partagés, accessibles depuis l'arbre de widgets.
class AppServices {
  AppServices({required this.config, required this.session, required this.lock, required this.store, required this.auth, required this.transfers, required this.recipients, required this.wallet, required this.kyc, required this.security});

  final AppConfig config;
  final SessionManager session;
  final AppLock lock;
  final SecureStore store;
  final AuthApi auth;
  final TransfersApi transfers;
  final RecipientsApi recipients;
  final WalletApi wallet;
  final KycApi kyc;
  final SecurityApi security;
}

class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.services, required super.child});

  final AppServices services;

  static AppServices of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope absent');
    return scope!.services;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => services != oldWidget.services;
}

extension AppContext on BuildContext {
  AppServices get services => AppScope.of(this);
}
