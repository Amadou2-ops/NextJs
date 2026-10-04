import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Text('TransfertPlus', style: text.displaySmall?.copyWith(fontWeight: FontWeight.w800, color: Theme.of(context).colorScheme.primary)),
              const SizedBox(height: 12),
              Text("Envoyez de l'argent vers le mobile money, les comptes bancaires et le retrait en espèces, au taux annoncé.", style: text.titleMedium),
              const Spacer(),
              FilledButton(onPressed: () => context.push('/inscription'), child: const Text('Créer un compte')),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () => context.push('/connexion'), child: const Text('Se connecter')),
            ],
          ),
        ),
      ),
    );
  }
}
