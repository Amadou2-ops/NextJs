import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/api/api_exception.dart';
import '../../core/security/device_key_store.dart';

/// Message présenté pour une erreur quelconque (jamais de détail technique).
String describeError(Object error) {
  if (error is ApiException) return error.userMessage;
  if (error is DeviceSecurityException) return 'Le composant de sécurité de votre téléphone n\'a pas pu être utilisé (${error.code}).';
  if (error is FormatException) return 'Réponse inattendue du service. Mettez l\'application à jour.';
  return 'Une erreur inattendue est survenue.';
}

class ErrorBanner extends StatelessWidget {
  const ErrorBanner(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: scheme.errorContainer, borderRadius: BorderRadius.circular(8)),
        child: Text(message, style: TextStyle(color: scheme.onErrorContainer)),
      ),
    );
  }
}

class InfoBanner extends StatelessWidget {
  const InfoBanner(this.message, {super.key, this.action});

  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: scheme.secondaryContainer, borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(message, style: TextStyle(color: scheme.onSecondaryContainer)),
          if (action != null) Padding(padding: const EdgeInsets.only(top: 8), child: action),
        ],
      ),
    );
  }
}

/// Bouton principal avec état d'attente (empêche la double soumission).
class BusyButton extends StatelessWidget {
  const BusyButton({super.key, required this.label, required this.busy, required this.onPressed});

  final String label;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: busy ? null : onPressed,
          child: busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(label),
        ),
      );
}

/// Chargement asynchrone avec gestion d'erreur et nouvel essai.
///
/// [refreshWhile] : tant qu'il renvoie vrai pour la dernière valeur chargée,
/// la valeur est relue toutes les [refreshEvery] sans masquer l'écran (suivi
/// d'une opération en cours côté serveur). Une relecture en échec garde la
/// dernière valeur affichée et sera retentée au tour suivant.
class Loader<T> extends StatefulWidget {
  const Loader({super.key, required this.load, required this.builder, this.refreshWhile, this.refreshEvery = const Duration(seconds: 3)});

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T value, Future<void> Function() reload) builder;
  final bool Function(T value)? refreshWhile;
  final Duration refreshEvery;

  @override
  State<Loader<T>> createState() => _LoaderState<T>();
}

class _LoaderState<T> extends State<Loader<T>> {
  late Future<T> _future = _track(widget.load());
  Timer? _refresh;

  /// Programme la relecture suivante si la valeur chargée l'exige.
  Future<T> _track(Future<T> future) {
    _refresh?.cancel();
    _refresh = null;
    unawaited(future.then(_schedule, onError: (Object _) {}));
    return future;
  }

  void _schedule(T value) {
    final refreshWhile = widget.refreshWhile;
    if (!mounted || refreshWhile == null || !refreshWhile(value)) return;
    _refresh?.cancel();
    _refresh = Timer(widget.refreshEvery, _silentRefresh);
  }

  Future<void> _silentRefresh() async {
    final T value;
    try {
      value = await widget.load();
    } on Object {
      if (mounted) _refresh = Timer(widget.refreshEvery, _silentRefresh);
      return;
    }
    if (!mounted) return;
    setState(() {
      _future = SynchronousFuture<T>(value);
    });
    _schedule(value);
  }

  Future<void> _reload() async {
    final next = _track(widget.load());
    // Bloc explicite : un setState dont la fonction renvoie un Future est refusé.
    setState(() {
      _future = next;
    });
    try {
      await next;
    } on Object {
      // Affiché par le FutureBuilder.
    }
  }

  @override
  void dispose() {
    _refresh?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          final error = snapshot.error;
          if (error != null) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ErrorBanner(describeError(error)),
                    OutlinedButton(onPressed: _reload, child: const Text('Réessayer')),
                  ],
                ),
              ),
            );
          }
          return widget.builder(context, snapshot.data as T, _reload);
        },
      );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 20, bottom: 8),
        child: Text(text, style: Theme.of(context).textTheme.titleMedium),
      );
}

/// Ligne libellé / valeur d'un récapitulatif.
class SummaryRow extends StatelessWidget {
  const SummaryRow(this.label, this.value, {super.key, this.emphasized = false});

  final String label;
  final String value;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    final style = emphasized ? Theme.of(context).textTheme.titleMedium : Theme.of(context).textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: Text(label, style: style)),
          const SizedBox(width: 12),
          Flexible(child: Text(value, style: style, textAlign: TextAlign.end)),
        ],
      ),
    );
  }
}

/// Validation simple d'un code à 6 chiffres.
String? sixDigits(String? value) => value != null && RegExp(r'^\d{6}$').hasMatch(value) ? null : 'Code à 6 chiffres';
