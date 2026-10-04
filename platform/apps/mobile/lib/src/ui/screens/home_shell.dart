import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/catalog.dart';
import '../../data/models.dart';
import '../widgets/common.dart';
import 'recipients_screen.dart';
import 'settings_screen.dart';
import 'transfers_screen.dart';

/// Espace client : accueil, transferts, bénéficiaires, profil.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.initialTab = 0});

  final int initialTab;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  late int _tab = widget.initialTab;

  static const _titles = ['TransfertPlus', 'Mes transferts', 'Bénéficiaires', 'Profil'];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_tab])),
      body: IndexedStack(
        index: _tab,
        children: const [_Dashboard(), TransfersTab(), RecipientsTab(), SettingsTab()],
      ),
      floatingActionButton: _tab <= 1
          ? FloatingActionButton.extended(onPressed: () => context.push('/envoyer'), icon: const Icon(Icons.send), label: const Text('Envoyer'))
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Accueil'),
          NavigationDestination(icon: Icon(Icons.swap_horiz), label: 'Transferts'),
          NavigationDestination(icon: Icon(Icons.people_outline), selectedIcon: Icon(Icons.people), label: 'Bénéficiaires'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profil'),
        ],
      ),
    );
  }
}

class _Dashboard extends StatelessWidget {
  const _Dashboard();

  @override
  Widget build(BuildContext context) {
    final services = context.services;
    return Loader<({List<Wallet> wallets, KycOverview kyc, List<Transfer> recent})>(
      load: () async {
        final results = await (services.wallet.wallets(), services.kyc.overview(), services.transfers.list(limit: 5)).wait;
        return (wallets: results.$1, kyc: results.$2, recent: results.$3.transfers);
      },
      builder: (context, data, reload) => RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (data.kyc.nextTier != null && data.kyc.activeVerification == null)
              InfoBanner(
                'Niveau actuel : ${kycTierLabel(data.kyc.tier)}. Plafond par transfert : ${formatMoney(data.kyc.singleTransferMax)}.',
                action: TextButton(onPressed: () => context.push('/verification'), child: const Text('Vérifier mon identité')),
              ),
            const SectionTitle('Portefeuilles'),
            if (data.wallets.isEmpty) const Text('Aucun portefeuille ouvert.'),
            for (final wallet in data.wallets)
              Card(
                child: ListTile(
                  title: Text(formatMoney(wallet.available), style: Theme.of(context).textTheme.titleLarge),
                  subtitle: Text(wallet.held.minor == BigInt.zero ? wallet.currency : '${wallet.currency} · ${formatMoney(wallet.held)} réservés'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/portefeuille/${wallet.currency}'),
                ),
              ),
            const SectionTitle('Derniers transferts'),
            if (data.recent.isEmpty) const Text("Vous n'avez encore envoyé aucun transfert."),
            for (final transfer in data.recent) TransferTile(transfer: transfer),
          ],
        ),
      ),
    );
  }
}
