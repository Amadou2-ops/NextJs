import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

/// Connexion : appareil de confiance (signature matérielle = second facteur)
/// ou nouvel appareil (attestation, puis code SMS ou TOTP).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _credentialsForm = GlobalKey<FormState>();
  final _codeForm = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();
  LoginSecondFactor? _pending;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (!_credentialsForm.currentState!.validate()) return;
    final auth = context.services.auth;
    await _run(() async {
      final outcome = await auth.login(phone: _phone.text.trim(), password: _password.text);
      if (outcome is LoginSecondFactor) setState(() => _pending = outcome);
    });
    // Le mot de passe n'est jamais conservé à l'écran au-delà de la tentative.
    _password.clear();
  }

  Future<void> _verify() async {
    if (!_codeForm.currentState!.validate()) return;
    final auth = context.services.auth;
    await _run(() => auth.verifyLogin(loginChallengeId: _pending!.loginChallengeId, code: _code.text));
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = _pending;
    return Scaffold(
      appBar: AppBar(title: const Text('Connexion')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (_error != null) ErrorBanner(_error!),
            if (pending == null)
              Form(
                key: _credentialsForm,
                child: AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextFormField(
                        controller: _phone,
                        keyboardType: TextInputType.phone,
                        autofillHints: const [AutofillHints.telephoneNumber],
                        decoration: const InputDecoration(labelText: 'Numéro de téléphone'),
                        validator: (value) => value != null && value.trim().length >= 6 ? null : 'Numéro de téléphone requis',
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _password,
                        obscureText: true,
                        autofillHints: const [AutofillHints.password],
                        decoration: const InputDecoration(labelText: 'Mot de passe'),
                        validator: (value) => value != null && value.isNotEmpty ? null : 'Mot de passe requis',
                      ),
                      const SizedBox(height: 16),
                      BusyButton(label: 'Se connecter', busy: _busy, onPressed: _login),
                      TextButton(onPressed: _busy ? null : () => context.push('/mot-de-passe-oublie'), child: const Text('Mot de passe oublié ?')),
                    ],
                  ),
                ),
              )
            else
              Form(
                key: _codeForm,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(pending.method == SecondFactorMethod.totp
                        ? "Nouvel appareil : saisissez le code de votre application d'authentification."
                        : 'Nouvel appareil : saisissez le code reçu par SMS.'),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _code,
                      keyboardType: TextInputType.number,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                      decoration: const InputDecoration(labelText: 'Code à 6 chiffres'),
                      validator: sixDigits,
                    ),
                    const SizedBox(height: 16),
                    BusyButton(label: 'Valider', busy: _busy, onPressed: _verify),
                    TextButton(onPressed: _busy ? null : () => setState(() => _pending = null), child: const Text('Recommencer')),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
