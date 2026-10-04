import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app_services.dart';
import '../../core/session/secure_store.dart';
import '../../data/catalog.dart';
import '../widgets/common.dart';

/// Inscription : numéro (code SMS), puis code, mot de passe et pays de
/// résidence. L'appareil est enregistré et attesté à la création du compte.
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _phoneForm = GlobalKey<FormState>();
  final _completeForm = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  SendingCountry _country = sendingCountries.first;
  bool _consent = false;
  String? _challengeId;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _password.dispose();
    _confirmation.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    if (!_phoneForm.currentState!.validate()) return;
    if (!_consent) {
      setState(() => _error = 'Acceptez les conditions et la politique de confidentialité pour continuer.');
      return;
    }
    await _run(() async {
      final challengeId = await context.services.auth.startRegistration(phone: _phone.text.trim(), countryHint: _country.country);
      setState(() => _challengeId = challengeId);
    });
  }

  Future<void> _complete() async {
    if (!_completeForm.currentState!.validate()) return;
    final services = context.services;
    await _run(() async {
      await services.auth.completeRegistration(
        challengeId: _challengeId!,
        code: _code.text,
        phone: _phone.text.trim(),
        password: _password.text,
        countryOfResidence: _country.country,
      );
      await services.store.write(StoreKeys.sourceCurrency, _country.currency);
      // Le routeur bascule vers l'espace client (session ouverte).
    });
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
      appBar: AppBar(title: const Text('Créer un compte')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (_error != null) ErrorBanner(_error!),
            if (_challengeId == null) _phoneStep() else _completeStep(),
          ],
        ),
      ),
    );
  }

  Widget _phoneStep() => Form(
        key: _phoneForm,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<SendingCountry>(
              isExpanded: true,
              initialValue: _country,
              decoration: const InputDecoration(labelText: 'Pays de résidence'),
              items: [for (final country in sendingCountries) DropdownMenuItem(value: country, child: Text(country.name))],
              onChanged: (value) => setState(() => _country = value ?? _country),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              autofillHints: const [AutofillHints.telephoneNumber],
              decoration: const InputDecoration(labelText: 'Numéro de téléphone mobile', hintText: '+33 6 12 34 56 78'),
              validator: (value) => value != null && RegExp(r'^[+0-9 ().-]{6,32}$').hasMatch(value.trim()) ? null : 'Numéro de téléphone invalide',
            ),
            const SizedBox(height: 8),
            CheckboxListTile(
              value: _consent,
              onChanged: (value) => setState(() => _consent = value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: const Text("J'accepte les conditions d'utilisation et la politique de confidentialité."),
            ),
            const SizedBox(height: 12),
            BusyButton(label: 'Recevoir un code par SMS', busy: _busy, onPressed: _sendCode),
          ],
        ),
      );

  Widget _completeStep() => Form(
        key: _completeForm,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Code envoyé au ${_phone.text.trim()}.'),
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
              controller: _password,
              obscureText: true,
              autofillHints: const [AutofillHints.newPassword],
              decoration: const InputDecoration(labelText: 'Mot de passe (10 caractères au moins)'),
              validator: (value) => value != null && value.runes.length >= 10 && value.length <= 128 ? null : '10 caractères au moins',
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _confirmation,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Confirmation du mot de passe'),
              validator: (value) => value == _password.text ? null : 'Les mots de passe ne correspondent pas',
            ),
            const SizedBox(height: 16),
            BusyButton(label: 'Créer mon compte', busy: _busy, onPressed: _complete),
            TextButton(onPressed: _busy ? null : () => setState(() => _challengeId = null), child: const Text('Changer de numéro')),
          ],
        ),
      );
}
