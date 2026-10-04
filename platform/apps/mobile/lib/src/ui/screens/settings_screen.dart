import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

class SettingsTab extends StatelessWidget {
  const SettingsTab({super.key});

  @override
  Widget build(BuildContext context) {
    final services = context.services;
    return ListView(
      padding: const EdgeInsets.all(8),
      children: [
        ListTile(leading: const Icon(Icons.verified_user_outlined), title: const Text("Vérification d'identité"), onTap: () => context.push('/verification')),
        ListTile(leading: const Icon(Icons.security), title: const Text('Sécurité du compte'), subtitle: const Text('Appareils, sessions, application d\'authentification'), onTap: () => context.push('/securite')),
        ListTile(leading: const Icon(Icons.lock_outline), title: const Text('Verrouiller maintenant'), onTap: services.lock.lock),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.logout),
          title: const Text('Se déconnecter'),
          onTap: () async {
            final confirmed = await showDialog<bool>(
              context: context,
              builder: (context) => AlertDialog(
                title: const Text('Se déconnecter ?'),
                content: const Text('Cet appareil reste de confiance : votre prochaine connexion ne demandera pas de code SMS.'),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
                  FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Se déconnecter')),
                ],
              ),
            );
            if (confirmed == true) await services.session.signOut();
          },
        ),
      ],
    );
  }
}

/// Sessions ouvertes, appareils de confiance, application d'authentification.
class SecurityScreen extends StatefulWidget {
  const SecurityScreen({super.key});

  @override
  State<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends State<SecurityScreen> {
  int _generation = 0;
  String? _error;
  String? _info;

  /// Action sensible : confirmation biométrique, puis appel signé par l'appareil.
  Future<void> _sensitive(String reason, Future<String?> Function() action) async {
    final services = context.services;
    if (!await services.lock.confirm(reason)) {
      setState(() => _error = 'Confirmation biométrique requise.');
      return;
    }
    setState(() {
      _error = null;
      _info = null;
    });
    try {
      final message = await action();
      if (mounted) {
        setState(() {
          _info = message;
          _generation++;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    }
  }

  Future<void> _enableTotp() async {
    final security = context.services.security;
    await _sensitive('Activez l\'application d\'authentification', () async {
      final setup = await security.startTotp();
      if (!mounted) return null;
      final code = await showDialog<String>(context: context, builder: (context) => _TotpDialog(secret: setup.secret, uri: setup.otpauthUri));
      if (code == null) return 'Activation abandonnée.';
      await security.confirmTotp(code);
      return 'Application d\'authentification activée.';
    });
  }

  Future<void> _disableTotp() async {
    final security = context.services.security;
    final code = await showDialog<String>(context: context, builder: (context) => const _CodeDialog(title: 'Désactiver l\'application d\'authentification'));
    if (code == null) return;
    await _sensitive('Désactivez l\'application d\'authentification', () async {
      await security.disableTotp(code);
      return 'Application d\'authentification désactivée.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final security = context.services.security;
    return Scaffold(
      appBar: AppBar(title: const Text('Sécurité')),
      body: Loader<({List<SessionSummary> sessions, List<DeviceSummary> devices})>(
        key: ValueKey(_generation),
        load: () async {
          final results = await (security.sessions(), security.devices()).wait;
          return (sessions: results.$1, devices: results.$2);
        },
        builder: (context, data, reload) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_error != null) ErrorBanner(_error!),
            if (_info != null) InfoBanner(_info!),
            const SectionTitle('Appareils de confiance'),
            for (final device in data.devices)
              ListTile(
                leading: Icon(device.platform == 'ios' ? Icons.phone_iphone : Icons.phone_android),
                title: Text(device.name),
                subtitle: Text(device.current ? 'Cet appareil' : 'Enregistré le ${formatDateTime(device.createdAt)}'),
                trailing: device.current
                    ? null
                    : IconButton(
                        tooltip: 'Retirer',
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () => _sensitive('Retirez l\'appareil ${device.name}', () async {
                          await security.revokeDevice(device.id);
                          return 'Appareil retiré : ses sessions sont fermées.';
                        }),
                      ),
              ),
            const SectionTitle('Sessions ouvertes'),
            for (final session in data.sessions)
              ListTile(
                leading: Icon(session.audience == 'web' ? Icons.language : Icons.smartphone),
                title: Text(session.deviceName ?? (session.audience == 'web' ? 'Navigateur web' : 'Application mobile')),
                subtitle: Text(session.current ? 'Session actuelle' : 'Dernière activité ${formatDateTime(session.lastUsedAt)}'),
                trailing: session.current
                    ? null
                    : IconButton(
                        tooltip: 'Fermer',
                        icon: const Icon(Icons.close),
                        onPressed: () => _sensitive('Fermez cette session', () async {
                          await security.revokeSession(session.id);
                          return 'Session fermée.';
                        }),
                      ),
              ),
            if (data.sessions.where((session) => !session.current).length > 1)
              TextButton(
                onPressed: () => _sensitive('Fermez les autres sessions', () async {
                  final revoked = await security.revokeOtherSessions();
                  return '$revoked session(s) fermée(s).';
                }),
                child: const Text('Fermer toutes les autres sessions'),
              ),
            const SectionTitle('Application d\'authentification (TOTP)'),
            const Text('Requise pour vous connecter sur un nouvel appareil et pour envoyer depuis le site web.'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                FilledButton.tonal(onPressed: _enableTotp, child: const Text('Activer')),
                OutlinedButton(onPressed: _disableTotp, child: const Text('Désactiver')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _TotpDialog extends StatefulWidget {
  const _TotpDialog({required this.secret, required this.uri});

  final String secret;
  final Uri uri;

  @override
  State<_TotpDialog> createState() => _TotpDialogState();
}

class _TotpDialogState extends State<_TotpDialog> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Application d\'authentification'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Ajoutez ce compte dans votre application (Google Authenticator, 1Password…) avec la clé :'),
            const SizedBox(height: 8),
            SelectableText(widget.secret, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w600)),
            TextButton.icon(
              onPressed: () => Clipboard.setData(ClipboardData(text: widget.secret)),
              icon: const Icon(Icons.copy),
              label: const Text('Copier la clé'),
            ),
            TextField(
              controller: _code,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
              decoration: const InputDecoration(labelText: 'Code affiché par l\'application'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annuler')),
          FilledButton(onPressed: () => sixDigits(_code.text) == null ? Navigator.pop(context, _code.text) : null, child: const Text('Activer')),
        ],
      );
}

class _CodeDialog extends StatefulWidget {
  const _CodeDialog({required this.title});

  final String title;

  @override
  State<_CodeDialog> createState() => _CodeDialogState();
}

class _CodeDialogState extends State<_CodeDialog> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: TextField(
          controller: _code,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          decoration: const InputDecoration(labelText: 'Code à 6 chiffres'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annuler')),
          FilledButton(onPressed: () => sixDigits(_code.text) == null ? Navigator.pop(context, _code.text) : null, child: const Text('Valider')),
        ],
      );
}
