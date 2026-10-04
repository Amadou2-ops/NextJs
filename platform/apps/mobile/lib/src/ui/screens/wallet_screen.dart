import 'package:flutter/material.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

/// Relevé d'un portefeuille (écritures du registre, solde après chaque mouvement).
class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key, required this.currency});

  final String currency;

  @override
  Widget build(BuildContext context) {
    final wallet = context.services.wallet;
    return Scaffold(
      appBar: AppBar(title: Text('Portefeuille $currency')),
      body: Loader<({List<StatementEntry> entries, String? nextCursor})>(
        load: () => wallet.statement(currency),
        builder: (context, statement, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (statement.entries.isEmpty) const Text('Aucun mouvement.'),
              for (final entry in statement.entries)
                ListTile(
                  title: Text(entry.description),
                  subtitle: Text('${formatDateTime(entry.effectiveAt)} · solde ${formatMoney(entry.balanceAfter)}'),
                  trailing: Text(
                    '${entry.incoming ? '+' : '−'}${formatMoney(entry.amount)}',
                    style: TextStyle(color: entry.incoming ? Colors.green.shade800 : null, fontWeight: FontWeight.w600),
                  ),
                ),
              if (statement.nextCursor != null) const Padding(padding: EdgeInsets.all(12), child: Text('Les mouvements plus anciens sont consultables sur le site.')),
            ],
          ),
        ),
      ),
    );
  }
}
