import 'package:flutter/widgets.dart';
import 'package:local_auth/local_auth.dart';

/// Verrouillage de l'application : biométrie ou code de l'appareil exigés au
/// démarrage d'une session, au retour après [timeout] en arrière-plan, et pour
/// confirmer chaque transfert.
abstract interface class DeviceAuthenticator {
  Future<bool> authenticate(String reason);
}

class LocalDeviceAuthenticator implements DeviceAuthenticator {
  LocalDeviceAuthenticator([LocalAuthentication? auth]) : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  @override
  Future<bool> authenticate(String reason) async {
    if (!await _auth.isDeviceSupported()) return false;
    try {
      // biometricOnly: false — le code de l'appareil reste accepté si la biométrie échoue.
      return await _auth.authenticate(localizedReason: reason, persistAcrossBackgrounding: true);
    } on LocalAuthException {
      return false;
    }
  }
}

class AppLock extends ChangeNotifier with WidgetsBindingObserver {
  AppLock(this._authenticator, {this.timeout = const Duration(seconds: 60), DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  final DeviceAuthenticator _authenticator;
  final Duration timeout;
  final DateTime Function() _clock;

  bool _locked = true;
  bool _obscured = false;
  DateTime? _backgroundedAt;

  /// Contenu masqué (verrou) : rien de sensible n'est affiché.
  bool get locked => _locked;

  /// Application inactive (sélecteur d'applications) : écran de confidentialité.
  bool get obscured => _obscured;

  Future<bool> unlock() async {
    final ok = await _authenticator.authenticate('Déverrouillez TransfertPlus');
    if (ok && _locked) {
      _locked = false;
      notifyListeners();
    }
    return ok;
  }

  /// L'utilisateur vient de s'authentifier (mot de passe + appareil) : pas de second déverrouillage.
  void markUnlocked() {
    if (_locked) {
      _locked = false;
      notifyListeners();
    }
  }

  /// Confirmation forte d'une opération (transfert, sécurité du compte).
  Future<bool> confirm(String reason) => _authenticator.authenticate(reason);

  void lock() {
    if (!_locked) {
      _locked = true;
      notifyListeners();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        _setObscured(true);
      case AppLifecycleState.paused:
        _backgroundedAt ??= _clock();
        _setObscured(true);
      case AppLifecycleState.resumed:
        final since = _backgroundedAt;
        _backgroundedAt = null;
        if (since != null && _clock().difference(since) >= timeout) lock();
        _setObscured(false);
      case AppLifecycleState.detached:
        break;
    }
  }

  void _setObscured(bool value) {
    if (_obscured != value) {
      _obscured = value;
      notifyListeners();
    }
  }
}
