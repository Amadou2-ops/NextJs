import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/models.dart';
import '../../data/payment_hosts.dart';
import '../widgets/common.dart';

/// Paiement d'un transfert : carte via Stripe PaymentSheet (3-D Secure géré
/// par Stripe) ou page hébergée du prestataire. Le statut fait foi côté API
/// (webhook signé) : l'écran ne fait que suivre la confirmation.
class PaymentScreen extends StatefulWidget {
  const PaymentScreen({super.key, required this.transferId});

  final String transferId;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  Transfer? _transfer;
  FundingAction? _funding;
  bool _loading = true;
  bool _busy = false;
  String? _error;
  String? _info;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_transfer == null && _error == null) unawaited(_load());
  }

  Future<void> _load() async {
    final transfers = context.services.transfers;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final transfer = await transfers.get(widget.transferId);
      final funding = transfer.status == TransferStatus.awaitingFunding ? await transfers.funding(widget.transferId) : null;
      if (mounted) {
        setState(() {
          _transfer = transfer;
          _funding = funding;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _payByCard(StripeFunding funding) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      Stripe.publishableKey = funding.publishableKey;
      Stripe.urlScheme = 'transfertplus';
      await Stripe.instance.applySettings();
      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters: SetupPaymentSheetParameters(
          paymentIntentClientSecret: funding.clientSecret,
          merchantDisplayName: 'TransfertPlus',
          returnURL: 'transfertplus://paiement/stripe',
        ),
      );
      await Stripe.instance.presentPaymentSheet();
      await _awaitConfirmation();
    } on StripeException catch (error) {
      if (mounted) {
        setState(() => _error = error.error.code == FailureCode.Canceled ? 'Paiement annulé.' : (error.error.localizedMessage ?? 'Paiement refusé.'));
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _payOnHostedPage(RedirectFunding funding) async {
    final url = trustedPaymentUrl(funding.url);
    if (url == null) {
      setState(() => _error = 'Lien de paiement inattendu : contactez le service client.');
      return;
    }
    // Navigateur sécurisé du système (Custom Tabs / SFSafariViewController), jamais une WebView.
    final opened = await launchUrl(url, mode: LaunchMode.inAppBrowserView);
    if (!opened) {
      setState(() => _error = "La page de paiement n'a pas pu être ouverte.");
      return;
    }
    if (mounted) setState(() => _info = 'Une fois le paiement terminé, revenez ici : le statut se mettra à jour.');
  }

  /// Suit la confirmation du paiement (webhook côté API) pendant 30 secondes.
  Future<void> _awaitConfirmation() async {
    final transfers = context.services.transfers;
    final router = GoRouter.of(context);
    for (var attempt = 0; attempt < 15; attempt++) {
      final transfer = await transfers.get(widget.transferId);
      if (transfer.status != TransferStatus.awaitingFunding) {
        unawaited(router.pushReplacement('/transferts/${widget.transferId}'));
        return;
      }
      await Future<void>.delayed(const Duration(seconds: 2));
    }
    if (mounted) setState(() => _info = 'Paiement transmis : la confirmation peut prendre quelques minutes.');
  }

  @override
  Widget build(BuildContext context) {
    final transfer = _transfer;
    final funding = _funding;
    return Scaffold(
      appBar: AppBar(title: const Text('Paiement')),
      body: SafeArea(
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  if (_error != null) ErrorBanner(_error!),
                  if (_info != null) InfoBanner(_info!),
                  if (transfer != null) ...[
                    Text('Transfert ${transfer.reference}', style: Theme.of(context).textTheme.titleMedium),
                    SummaryRow('Total à payer', formatMoney(transfer.totalToPay), emphasized: true),
                    SummaryRow('Le bénéficiaire reçoit', formatMoney(transfer.receiveAmount)),
                    const SizedBox(height: 20),
                    switch (funding) {
                      StripeFunding() => BusyButton(label: 'Payer par carte', busy: _busy, onPressed: () => _payByCard(funding)),
                      RedirectFunding() => BusyButton(label: 'Continuer vers le paiement sécurisé', busy: _busy, onPressed: () => _payOnHostedPage(funding)),
                      null => const Text("Ce transfert n'attend plus de paiement."),
                    },
                    const SizedBox(height: 12),
                    OutlinedButton(onPressed: () => context.pushReplacement('/transferts/${widget.transferId}'), child: const Text('Voir le transfert')),
                  ] else
                    OutlinedButton(onPressed: _load, child: const Text('Réessayer')),
                ],
              ),
      ),
    );
  }
}
