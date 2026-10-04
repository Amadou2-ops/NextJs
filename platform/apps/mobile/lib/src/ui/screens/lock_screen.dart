import 'package:flutter/material.dart';

import '../../app_services.dart';

/// Écran de verrouillage : rien de sensible n'est rendu tant que l'utilisateur
/// ne s'est pas authentifié (biométrie ou code de l'appareil).
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _failed = false;
  bool _prompting = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_prompting && !_failed) WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  Future<void> _unlock() async {
    if (_prompting) return;
    final lock = context.services.lock;
    setState(() => _prompting = true);
    final ok = await lock.unlock();
    if (mounted) {
      setState(() {
        _prompting = false;
        _failed = !ok;
      });
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.lock, size: 56, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 16),
                  Text('TransfertPlus est verrouillé', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 8),
                  if (_failed) const Text('Authentification requise. Activez un code ou la biométrie sur votre appareil si nécessaire.', textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  FilledButton(onPressed: _prompting ? null : _unlock, child: const Text('Déverrouiller')),
                ],
              ),
            ),
          ),
        ),
      );
}

/// Masque le contenu dans le sélecteur d'applications (aperçu système).
class PrivacyCover extends StatelessWidget {
  const PrivacyCover({super.key});

  @override
  Widget build(BuildContext context) => ColoredBox(
        color: Theme.of(context).colorScheme.surface,
        child: Center(child: Icon(Icons.shield, size: 64, color: Theme.of(context).colorScheme.primary)),
      );
}
