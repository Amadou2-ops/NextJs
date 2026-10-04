import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/catalog.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

class TransferTile extends StatelessWidget {
  const TransferTile({super.key, required this.transfer});

  final Transfer transfer;

  @override
  Widget build(BuildContext context) => Card(
        child: ListTile(
          title: Text('${formatMoney(transfer.receiveAmount)} → ${transfer.recipientHint}'),
          subtitle: Text('${transferStatusLabel(transfer.status)} · ${formatDateTime(transfer.createdAt)}'),
          trailing: Text(formatMoney(transfer.totalToPay)),
          onTap: () => context.push('/transferts/${transfer.id}'),
        ),
      );
}

/// Historique paginé des transferts.
class TransfersTab extends StatefulWidget {
  const TransfersTab({super.key});

  @override
  State<TransfersTab> createState() => _TransfersTabState();
}

class _TransfersTabState extends State<TransfersTab> {
  final List<Transfer> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_items.isEmpty && !_loading && !_done) unawaited(_more());
  }

  Future<void> _refresh() async {
    setState(() {
      _items.clear();
      _cursor = null;
      _done = false;
    });
    await _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    final transfers = context.services.transfers;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await transfers.list(before: _cursor);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.transfers);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_error != null) ErrorBanner(_error!),
            if (_items.isEmpty && _done) const Text("Vous n'avez encore envoyé aucun transfert."),
            for (final transfer in _items) TransferTile(transfer: transfer),
            if (_loading) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
            if (!_loading && !_done && _items.isNotEmpty) OutlinedButton(onPressed: _more, child: const Text('Afficher plus')),
          ],
        ),
      );
}

/// Détail, suivi et annulation d'un transfert.
class TransferDetailScreen extends StatelessWidget {
  const TransferDetailScreen({super.key, required this.transferId});

  /// Statuts dont l'issue dépend du serveur (paiement, envoi, remboursement).
  static const _inFlight = {
    TransferStatus.fundingProcessing,
    TransferStatus.funded,
    TransferStatus.complianceReview,
    TransferStatus.payoutPending,
    TransferStatus.payoutProcessing,
    TransferStatus.payoutFailed,
    TransferStatus.refundPending,
  };

  final String transferId;

  @override
  Widget build(BuildContext context) {
    final services = context.services;
    return Scaffold(
      appBar: AppBar(title: const Text('Transfert')),
      body: Loader<Transfer>(
        load: () => services.transfers.get(transferId),
        // Suivi en direct tant que le traitement se poursuit côté serveur.
        refreshWhile: (transfer) => _inFlight.contains(transfer.status),
        builder: (context, transfer, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(transfer.reference, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(transferStatusLabel(transfer.status), style: Theme.of(context).textTheme.titleMedium),
              if (transfer.statusReason != null) Text(transfer.statusReason!),
              const SizedBox(height: 12),
              SummaryRow('Bénéficiaire', transfer.recipientHint),
              SummaryRow('Montant envoyé', formatMoney(transfer.sendAmount)),
              SummaryRow('Frais', formatMoney(transfer.fee)),
              SummaryRow('Total payé', formatMoney(transfer.totalToPay), emphasized: true),
              SummaryRow('Taux', formatRate(transfer.exchangeRate, transfer.sendAmount.currency, transfer.receiveAmount.currency)),
              SummaryRow('Montant reçu', formatMoney(transfer.receiveAmount), emphasized: true),
              SummaryRow('Réception', payoutLabel(transfer.payoutMethod)),
              SummaryRow('Paiement', fundingLabel(transfer.fundingMethod)),
              if (transfer.status == TransferStatus.awaitingFunding) ...[
                const SizedBox(height: 16),
                FilledButton(onPressed: () => context.push('/transferts/${transfer.id}/paiement'), child: const Text('Payer ce transfert')),
              ],
              if (transfer.cancellable) ...[
                const SizedBox(height: 8),
                _CancelButton(transfer: transfer, onCancelled: reload),
              ],
              if (transfer.history.isNotEmpty) ...[
                const SectionTitle('Suivi'),
                for (final step in transfer.history)
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.check_circle_outline),
                    title: Text(transferStatusLabel(step.status)),
                    subtitle: Text(formatDateTime(step.at)),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _CancelButton extends StatefulWidget {
  const _CancelButton({required this.transfer, required this.onCancelled});

  final Transfer transfer;
  final Future<void> Function() onCancelled;

  @override
  State<_CancelButton> createState() => _CancelButtonState();
}

class _CancelButtonState extends State<_CancelButton> {
  bool _busy = false;

  Future<void> _cancel() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Annuler ce transfert ?'),
        content: const Text("Le transfert n'a pas encore été payé ; il sera définitivement annulé."),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Non')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Annuler le transfert')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final services = context.services;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await services.transfers.cancel(widget.transfer.id);
      await widget.onCancelled();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(describeError(error))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => OutlinedButton(onPressed: _busy ? null : _cancel, child: const Text('Annuler le transfert'));
}
