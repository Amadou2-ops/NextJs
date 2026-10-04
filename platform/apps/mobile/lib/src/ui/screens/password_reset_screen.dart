import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/api/api_exception.dart';
import '../../data/catalog.dart';
import '../widgets/common.dart';

/// Mot de passe oublié : numéro (code SMS si un compte actif y correspond),
/// puis code, code de l'application d'authentification si elle est activée,
/// et nouveau mot de passe. Toutes les sessions du compte sont fermées.
class PasswordResetScreen extends StatefulWidget {
  const PasswordResetScreen({super.key});

  @override
  State<PasswordResetScreen> createState() => _PasswordResetScreenState();
}

class _PasswordResetScreenState extends State<PasswordResetScreen> {
  final _phoneForm = GlobalKey<FormState>();
  final _resetForm = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _totp = TextEditingController();
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  SendingCountry _country = sendingCountries.first;
  String? _challengeId;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final controller in [_phone, _code, _totp, _password, _confirmation]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _start() async {
    if (!_phoneForm.currentState!.validate()) return;
    final auth = context.services.auth;
    await _run(() async {
      final challengeId = await auth.startPasswordReset(phone: _phone.text.trim(), countryHint: _country.country);
      setState(() => _challengeId = challengeId);
    });
  }

  Future<void> _complete() async {
    if (!_resetForm.currentState!.validate()) return;
    final auth = context.services.auth;
    final router = GoRouter.of(context);
    final messenger = ScaffoldMessenger.of(context);
    var done = false;
    await _run(() async {
      try {
        await auth.completePasswordReset(
          challengeId: _challengeId!,
          code: _code.text,
          phone: _phone.text.trim(),
          countryHint: _country.country,
          password: _password.text,
          totpCode: _totp.text.isEmpty ? null : _totp.text,
        );
        done = true;
      } on ApiException catch (error) {
        // Code SMS consommé ou expiré : un nouveau code est nécessaire.
        if (error.code == 'TOTP_REQUIRED' || error.code == 'VERIFICATION_EXPIRED') setState(() => _challengeId = null);
        rethrow;
      }
    });
    _password.clear();
    _confirmation.clear();
    if (!done) return;
    messenger.showSnackBar(const SnackBar(content: Text('Mot de passe modifié. Connectez-vous avec le nouveau.')));
    router.go('/connexion');
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
    return Scaffold(
      appBar: AppBar(title: const Text('Mot de passe oublié')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [if (_error != null) ErrorBanner(_error!), if (_challengeId == null) _phoneStep() else _resetStep()],
        ),
      ),
    );
  }

  Widget _phoneStep() => Form(
    key: _phoneForm,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Si un compte correspond à ce numéro, vous recevrez un code par SMS.'),
        const SizedBox(height: 12),
        DropdownButtonFormField<SendingCountry>(
          isExpanded: true,
          initialValue: _country,
          decoration: const InputDecoration(labelText: 'Pays'),
          items: [for (final country in sendingCountries) DropdownMenuItem(value: country, child: Text(country.name))],
          onChanged: (value) => setState(() => _country = value ?? _country),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          autofillHints: const [AutofillHints.telephoneNumber],
          decoration: const InputDecoration(labelText: 'Numéro de téléphone du compte'),
          validator: (value) => value != null && value.trim().length >= 6 ? null : 'Numéro de téléphone requis',
        ),
        const SizedBox(height: 16),
        BusyButton(label: 'Recevoir un code par SMS', busy: _busy, onPressed: _start),
      ],
    ),
  );

  Widget _resetStep() => Form(
    key: _resetForm,
    child: AutofillGroup(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Toutes vos sessions seront fermées, sur tous vos appareils.'),
          const SizedBox(height: 12),
          TextFormField(
            controller: _code,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: 'Code reçu par SMS'),
            validator: sixDigits,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _totp,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: "Code de l'application d'authentification (si activée)"),
            validator: (value) => value == null || value.isEmpty ? null : sixDigits(value),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _password,
            obscureText: true,
            autofillHints: const [AutofillHints.newPassword],
            decoration: const InputDecoration(labelText: 'Nouveau mot de passe (10 caractères au moins)'),
            validator: (value) => value != null && value.length >= 10 && value.length <= 128 ? null : '10 caractères au moins',
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _confirmation,
            obscureText: true,
            autofillHints: const [AutofillHints.newPassword],
            decoration: const InputDecoration(labelText: 'Confirmation du mot de passe'),
            validator: (value) => value == _password.text ? null : 'Les mots de passe ne correspondent pas',
          ),
          const SizedBox(height: 16),
          BusyButton(label: 'Changer mon mot de passe', busy: _busy, onPressed: _complete),
          TextButton(onPressed: _busy ? null : () => setState(() => _challengeId = null), child: const Text('Demander un nouveau code')),
        ],
      ),
    ),
  );
}
