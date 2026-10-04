import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../core/session/secure_store.dart';
import '../../data/api.dart';
import '../../data/catalog.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

/// Parcours d'envoi : devis garanti → bénéficiaire → motif → confirmation
/// biométrique → transfert signé par l'appareil → paiement.
class SendScreen extends StatefulWidget {
  const SendScreen({super.key});

  @override
  State<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends State<SendScreen> {
  static const _sourceCurrencies = ['EUR', 'GBP', 'USD', 'CAD'];
  static const _fundingMethods = [FundingMethod.card, FundingMethod.bankTransfer, FundingMethod.walletBalance];

  final _amount = TextEditingController();
  Corridor _corridor = corridors.first;
  late PayoutMethod _payout = _corridor.payoutMethods.first;
  FundingMethod _funding = FundingMethod.card;
  String _sourceCurrency = 'EUR';
  bool _amountIsReceive = false;

  Quote? _quote;
  Recipient? _recipient;
  String _purpose = 'family_support';
  List<Recipient>? _recipients;

  /// Clé d'idempotence du transfert en cours de création : conservée entre
  /// les tentatives (réseau coupé, nouvelle confirmation), renouvelée seulement
  /// quand le devis ou le bénéficiaire change.
  String? _idempotencyKey;

  Timer? _ticker;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _quote != null) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_recipients == null) unawaited(_loadPreferences());
  }

  Future<void> _loadPreferences() async {
    final services = context.services;
    final stored = await services.store.read(StoreKeys.sourceCurrency);
    try {
      final recipients = await services.recipients.list();
      if (!mounted) return;
      setState(() {
        if (stored != null && _sourceCurrencies.contains(stored)) _sourceCurrency = stored;
        _recipients = recipients;
      });
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _amount.dispose();
    super.dispose();
  }

  void _invalidateQuote() {
    _quote = null;
    _idempotencyKey = null;
  }

  Duration? get _remaining {
    final expiresAt = _quote?.expiresAt;
    if (expiresAt == null) return null;
    final left = expiresAt.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  Future<void> _requestQuote() async {
    final currency = _amountIsReceive ? _corridor.currency : _sourceCurrency;
    final minor = decimalToMinor(_amount.text, currencyDigits(currency));
    if (minor == null) {
      setState(() => _error = 'Montant invalide (${currencyDigits(currency)} décimale(s) au plus).');
      return;
    }
    final services = context.services;
    await _run(() async {
      final quote = await services.transfers.quote(QuoteRequest(
        destinationCountry: _corridor.country,
        sourceCurrency: _sourceCurrency,
        destinationCurrency: _corridor.currency,
        payoutMethod: _payout,
        fundingMethod: _funding,
        amountMinor: minor,
        amountType: _amountIsReceive ? 'receive' : 'send',
      ));
      await services.store.write(StoreKeys.sourceCurrency, _sourceCurrency);
      setState(() {
        _quote = quote;
        _idempotencyKey = null;
      });
    });
  }

  Future<void> _addRecipient() async {
    final created = await context.push<Recipient>('/beneficiaires/nouveau', extra: (corridor: _corridor, payoutMethod: _payout));
    if (created == null || !mounted) return;
    setState(() {
      _recipients = [created, ...?_recipients];
      _recipient = created;
      _idempotencyKey = null;
    });
  }

  Future<void> _confirm() async {
    final quote = _quote;
    final recipient = _recipient;
    if (quote == null || quote.quoteId == null || recipient == null) return;
    if (_remaining == Duration.zero) {
      setState(() => _error = 'Ce devis a expiré : demandez-en un nouveau.');
      return;
    }
    final services = context.services;
    final router = GoRouter.of(context);
    final approved = await services.lock.confirm('Confirmez l\'envoi de ${formatMoney(quote.receiveAmount)} à ${recipient.fullName}');
    if (!approved) {
      setState(() => _error = 'Confirmation biométrique requise pour envoyer.');
      return;
    }
    final key = _idempotencyKey ??= TransfersApi.newIdempotencyKey();
    await _run(() async {
      final created = await services.transfers.create(quoteId: quote.quoteId!, recipientId: recipient.id, purposeCode: _purpose, idempotencyKey: key);
      final id = created.transfer.id;
      unawaited(router.pushReplacement(created.funding == null ? '/transferts/$id' : '/transferts/$id/paiement'));
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
    final quote = _quote;
    return Scaffold(
      appBar: AppBar(title: const Text('Envoyer de l\'argent')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (_error != null) ErrorBanner(_error!),
            DropdownButtonFormField<Corridor>(
              initialValue: _corridor,
              decoration: const InputDecoration(labelText: 'Pays de destination'),
              items: [for (final corridor in corridors) DropdownMenuItem(value: corridor, child: Text('${corridor.name} (${corridor.currency})'))],
              onChanged: _busy
                  ? null
                  : (value) => setState(() {
                        if (value == null) return;
                        _corridor = value;
                        _payout = value.payoutMethods.first;
                        _recipient = null;
                        _invalidateQuote();
                      }),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                for (final method in _corridor.payoutMethods)
                  ChoiceChip(
                    label: Text(payoutLabel(method)),
                    selected: method == _payout,
                    onSelected: (_) => setState(() {
                      _payout = method;
                      _recipient = null;
                      _invalidateQuote();
                    }),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: InputDecoration(labelText: _amountIsReceive ? 'Montant à recevoir' : 'Montant à envoyer'),
                    onChanged: (_) => setState(_invalidateQuote),
                  ),
                ),
                const SizedBox(width: 12),
                DropdownButton<String>(
                  value: _amountIsReceive ? _corridor.currency : _sourceCurrency,
                  items: [
                    for (final currency in _sourceCurrencies) DropdownMenuItem(value: currency, child: Text(currency)),
                    if (!_sourceCurrencies.contains(_corridor.currency)) DropdownMenuItem(value: _corridor.currency, child: Text(_corridor.currency)),
                  ],
                  onChanged: (value) => setState(() {
                    if (value == null) return;
                    if (value == _corridor.currency) {
                      _amountIsReceive = true;
                    } else {
                      _amountIsReceive = false;
                      _sourceCurrency = value;
                    }
                    _invalidateQuote();
                  }),
                ),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<FundingMethod>(
              initialValue: _funding,
              decoration: const InputDecoration(labelText: 'Moyen de paiement'),
              items: [for (final method in _fundingMethods) DropdownMenuItem(value: method, child: Text(fundingLabel(method)))],
              onChanged: (value) => setState(() {
                _funding = value ?? _funding;
                _invalidateQuote();
              }),
            ),
            const SizedBox(height: 16),
            if (quote == null)
              BusyButton(label: 'Voir le devis', busy: _busy, onPressed: _requestQuote)
            else
              _QuoteCard(quote: quote, remaining: _remaining, onRefresh: _busy ? null : _requestQuote),
            if (quote != null) ...[
              const SectionTitle('Bénéficiaire'),
              if (_recipients == null) const LinearProgressIndicator(),
              RadioGroup<String>(
                groupValue: _recipient?.id,
                onChanged: (id) => setState(() {
                  _recipient = _recipients?.firstWhere((item) => item.id == id);
                  _idempotencyKey = null;
                }),
                child: Column(
                  children: [
                    for (final recipient in (_recipients ?? const <Recipient>[]).where((item) => item.country == _corridor.country && item.payoutMethod == _payout))
                      RadioListTile<String>(value: recipient.id, title: Text(recipient.fullName), subtitle: Text(recipient.displayHint)),
                  ],
                ),
              ),
              TextButton.icon(onPressed: _busy ? null : _addRecipient, icon: const Icon(Icons.person_add), label: const Text('Nouveau bénéficiaire')),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _purpose,
                decoration: const InputDecoration(labelText: 'Motif du transfert'),
                items: [for (final entry in purposes.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
                onChanged: (value) => setState(() => _purpose = value ?? _purpose),
              ),
              const SizedBox(height: 20),
              BusyButton(
                label: 'Confirmer et envoyer ${formatMoney(quote.totalToPay)}',
                busy: _busy,
                onPressed: _recipient == null || _remaining == Duration.zero ? null : _confirm,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.quote, required this.remaining, required this.onRefresh});

  final Quote quote;
  final Duration? remaining;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    final expired = remaining == Duration.zero;
    final seconds = remaining?.inSeconds;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SummaryRow('Vous envoyez', formatMoney(quote.sendAmount)),
            SummaryRow('Frais', formatMoney(quote.fee)),
            SummaryRow('Total à payer', formatMoney(quote.totalToPay), emphasized: true),
            SummaryRow('Taux', formatRate(quote.exchangeRate, quote.sendAmount.currency, quote.receiveAmount.currency)),
            SummaryRow('Le bénéficiaire reçoit', formatMoney(quote.receiveAmount), emphasized: true),
            if (quote.estimatedDeliveryMinutes != null) SummaryRow('Délai estimé', '${quote.estimatedDeliveryMinutes} min'),
            const SizedBox(height: 8),
            if (expired)
              OutlinedButton(onPressed: onRefresh, child: const Text('Devis expiré : actualiser'))
            else if (seconds != null)
              Text('Taux garanti encore ${seconds ~/ 60} min ${(seconds % 60).toString().padLeft(2, '0')} s', textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
