import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/api/api_exception.dart';
import '../../data/catalog.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

class RecipientsTab extends StatelessWidget {
  const RecipientsTab({super.key});

  @override
  Widget build(BuildContext context) {
    final services = context.services;
    return Loader<List<Recipient>>(
      load: services.recipients.list,
      builder: (context, recipients, reload) => RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (recipients.isEmpty) const Text('Aucun bénéficiaire enregistré. Vous en ajouterez un lors de votre premier envoi.'),
            for (final recipient in recipients)
              Card(
                child: ListTile(
                  title: Text(recipient.fullName),
                  subtitle: Text('${payoutLabel(recipient.payoutMethod)} · ${recipient.displayHint} · ${recipient.country}'),
                  trailing: IconButton(
                    tooltip: 'Supprimer',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () => _archive(context, recipient, reload),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _archive(BuildContext context, Recipient recipient, Future<void> Function() reload) async {
    final services = context.services;
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Supprimer ${recipient.fullName} ?'),
        content: const Text('Les transferts passés restent consultables.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Supprimer')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await services.recipients.archive(recipient.id);
      await reload();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(describeError(error))));
    }
  }
}

/// Ajout d'un bénéficiaire pour un corridor et un mode de réception donnés.
class RecipientFormScreen extends StatefulWidget {
  const RecipientFormScreen({super.key, required this.corridor, required this.payoutMethod});

  final Corridor corridor;
  final PayoutMethod payoutMethod;

  @override
  State<RecipientFormScreen> createState() => _RecipientFormScreenState();
}

class _RecipientFormScreenState extends State<RecipientFormScreen> {
  final _form = GlobalKey<FormState>();
  final _firstName = TextEditingController();
  final _lastName = TextEditingController();
  final _msisdn = TextEditingController();
  final _iban = TextEditingController();
  final _accountNumber = TextEditingController();
  final _bankCode = TextEditingController();
  String _relationship = 'family';
  String? _operator;
  bool _busy = false;
  String? _error;
  Map<String, String> _fieldErrors = const {};

  @override
  void dispose() {
    for (final controller in [_firstName, _lastName, _msisdn, _iban, _accountNumber, _bankCode]) {
      controller.dispose();
    }
    super.dispose();
  }

  Map<String, String> _account() => switch (widget.payoutMethod) {
        PayoutMethod.mobileMoney => {'kind': 'mobile_money', 'msisdn': _msisdn.text.trim(), 'operator': _operator ?? ''},
        PayoutMethod.cashPickup => {'kind': 'cash_pickup', 'msisdn': _msisdn.text.trim()},
        _ => _iban.text.trim().isNotEmpty
            ? {'kind': 'bank_account', 'iban': _iban.text.replaceAll(' ', '').toUpperCase()}
            : {'kind': 'bank_account', 'accountNumber': _accountNumber.text.trim(), if (_bankCode.text.trim().isNotEmpty) 'bankCode': _bankCode.text.trim()},
      };

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final services = context.services;
    final router = GoRouter.of(context);
    setState(() {
      _busy = true;
      _error = null;
      _fieldErrors = const {};
    });
    try {
      final recipient = await services.recipients.create(
        country: widget.corridor.country,
        currency: widget.corridor.currency,
        firstName: _firstName.text.trim(),
        lastName: _lastName.text.trim(),
        relationship: _relationship,
        account: _account(),
      );
      router.pop(recipient);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _error = describeError(error);
        if (error is ApiException) {
          _fieldErrors = {
            for (final field in const ['firstName', 'lastName'])
              if (error.fieldError(field) != null) field: error.fieldError(field)!,
          };
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _required(String? value, String message) => value != null && value.trim().isNotEmpty ? null : message;

  @override
  Widget build(BuildContext context) {
    final method = widget.payoutMethod;
    final phoneBased = method == PayoutMethod.mobileMoney || method == PayoutMethod.cashPickup;
    return Scaffold(
      appBar: AppBar(title: Text('Bénéficiaire · ${widget.corridor.name}')),
      body: SafeArea(
        child: Form(
          key: _form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (_error != null) ErrorBanner(_error!),
              Text(payoutLabel(method), style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 12),
              TextFormField(controller: _firstName, decoration: InputDecoration(labelText: 'Prénom', errorText: _fieldErrors['firstName']), validator: (value) => _required(value, 'Prénom requis')),
              const SizedBox(height: 12),
              TextFormField(controller: _lastName, decoration: InputDecoration(labelText: 'Nom', errorText: _fieldErrors['lastName']), validator: (value) => _required(value, 'Nom requis')),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                isExpanded: true,
                initialValue: _relationship,
                decoration: const InputDecoration(labelText: 'Lien avec vous'),
                items: [for (final entry in relationships.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
                onChanged: (value) => setState(() => _relationship = value ?? _relationship),
              ),
              const SizedBox(height: 12),
              if (phoneBased)
                TextFormField(
                  controller: _msisdn,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Numéro de téléphone du bénéficiaire'),
                  validator: (value) => value != null && value.trim().length >= 6 ? null : 'Numéro de téléphone requis',
                ),
              if (method == PayoutMethod.mobileMoney) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  isExpanded: true,
                  initialValue: _operator,
                  decoration: const InputDecoration(labelText: 'Opérateur'),
                  items: [for (final entry in mobileOperatorsFor(widget.corridor.country).entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
                  onChanged: (value) => setState(() => _operator = value),
                  validator: (value) => value == null ? 'Opérateur requis' : null,
                ),
              ],
              if (method == PayoutMethod.bankAccount) ...[
                TextFormField(
                  controller: _iban,
                  decoration: const InputDecoration(labelText: 'IBAN', helperText: 'Ou, à défaut, numéro de compte ci-dessous'),
                  validator: (value) => (value ?? '').trim().isEmpty && _accountNumber.text.trim().isEmpty ? 'IBAN ou numéro de compte requis' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(controller: _accountNumber, decoration: const InputDecoration(labelText: 'Numéro de compte')),
                const SizedBox(height: 12),
                TextFormField(controller: _bankCode, decoration: const InputDecoration(labelText: 'Code banque (facultatif)')),
              ],
              const SizedBox(height: 20),
              BusyButton(label: 'Enregistrer le bénéficiaire', busy: _busy, onPressed: _save),
            ],
          ),
        ),
      ),
    );
  }
}
