import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';

import 'app_services.dart';
import 'core/session/session_manager.dart';
import 'data/catalog.dart';
import 'data/models.dart';
import 'ui/screens/home_shell.dart';
import 'ui/screens/kyc_screen.dart';
import 'ui/screens/lock_screen.dart';
import 'ui/screens/login_screen.dart';
import 'ui/screens/password_reset_screen.dart';
import 'ui/screens/payment_screen.dart';
import 'ui/screens/recipients_screen.dart';
import 'ui/screens/register_screen.dart';
import 'ui/screens/send_screen.dart';
import 'ui/screens/settings_screen.dart';
import 'ui/screens/transfers_screen.dart';
import 'ui/screens/wallet_screen.dart';
import 'ui/screens/welcome_screen.dart';

const Set<String> _publicPaths = {'/bienvenue', '/inscription', '/connexion', '/mot-de-passe-oublie'};
final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

GoRouter buildRouter(AppServices services) {
  final session = services.session;
  return GoRouter(
    initialLocation: '/',
    refreshListenable: session,
    redirect: (context, state) {
      final path = state.uri.path;
      switch (session.status) {
        case SessionStatus.unknown:
          return path == '/chargement' ? null : '/chargement';
        case SessionStatus.signedOut:
          return _publicPaths.contains(path) ? null : '/bienvenue';
        case SessionStatus.signedIn:
          if (_publicPaths.contains(path) || path == '/chargement') return '/';
          return null;
      }
    },
    // Lien inconnu (retour d'une page de paiement, lien forgé) : accueil.
    errorBuilder: (context, state) => const HomeShell(),
    routes: [
      GoRoute(path: '/chargement', builder: (context, state) => const Scaffold(body: Center(child: CircularProgressIndicator()))),
      GoRoute(path: '/bienvenue', builder: (context, state) => const WelcomeScreen()),
      GoRoute(path: '/inscription', builder: (context, state) => const RegisterScreen()),
      GoRoute(path: '/connexion', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/mot-de-passe-oublie', builder: (context, state) => const PasswordResetScreen()),
      GoRoute(path: '/', builder: (context, state) => const HomeShell()),
      GoRoute(path: '/envoyer', builder: (context, state) => const SendScreen()),
      GoRoute(
        path: '/beneficiaires/nouveau',
        builder: (context, state) {
          final extra = state.extra;
          if (extra is ({Corridor corridor, PayoutMethod payoutMethod})) return RecipientFormScreen(corridor: extra.corridor, payoutMethod: extra.payoutMethod);
          return const HomeShell(initialTab: 2);
        },
      ),
      GoRoute(
        path: '/transferts/:id',
        redirect: (context, state) => _uuid.hasMatch(state.pathParameters['id'] ?? '') ? null : '/',
        builder: (context, state) => TransferDetailScreen(transferId: state.pathParameters['id']!),
        routes: [GoRoute(path: 'paiement', builder: (context, state) => PaymentScreen(transferId: state.pathParameters['id']!))],
      ),
      GoRoute(
        path: '/portefeuille/:currency',
        redirect: (context, state) => RegExp(r'^[A-Z]{3}$').hasMatch(state.pathParameters['currency'] ?? '') ? null : '/',
        builder: (context, state) => WalletScreen(currency: state.pathParameters['currency']!),
      ),
      GoRoute(path: '/verification', builder: (context, state) => const KycScreen()),
      GoRoute(path: '/securite', builder: (context, state) => const SecurityScreen()),
    ],
  );
}

class TransfertPlusApp extends StatefulWidget {
  const TransfertPlusApp({super.key, required this.services});

  final AppServices services;

  @override
  State<TransfertPlusApp> createState() => _TransfertPlusAppState();
}

class _TransfertPlusAppState extends State<TransfertPlusApp> {
  late final GoRouter _router = buildRouter(widget.services);
  SessionStatus? _previous;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(widget.services.lock);
    widget.services.session.addListener(_onSession);
  }

  /// Connexion ou inscription réussie : l'utilisateur vient de s'authentifier.
  /// Session reprise au démarrage : déverrouillage biométrique exigé.
  void _onSession() {
    final status = widget.services.session.status;
    if (_previous == SessionStatus.signedOut && status == SessionStatus.signedIn) widget.services.lock.markUnlocked();
    if (status == SessionStatus.signedOut) widget.services.lock.lock();
    _previous = status;
  }

  @override
  void dispose() {
    widget.services.session.removeListener(_onSession);
    WidgetsBinding.instance.removeObserver(widget.services.lock);
    _router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF0B6E4F);
    return AppScope(
      services: widget.services,
      child: MaterialApp.router(
        title: 'TransfertPlus',
        debugShowCheckedModeBanner: false,
        locale: const Locale('fr', 'FR'),
        supportedLocales: const [Locale('fr', 'FR')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed), useMaterial3: true),
        darkTheme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark), useMaterial3: true),
        routerConfig: _router,
        builder: (context, child) => ListenableBuilder(
          listenable: Listenable.merge([widget.services.lock, widget.services.session]),
          builder: (context, _) {
            final lock = widget.services.lock;
            final signedIn = widget.services.session.status == SessionStatus.signedIn;
            return Stack(
              children: [
                // Session verrouillée : le contenu n'est pas construit du tout.
                if (signedIn && lock.locked) const LockScreen() else child ?? const SizedBox.shrink(),
                if (lock.obscured) const Positioned.fill(child: PrivacyCover()),
              ],
            );
          },
        ),
      ),
    );
  }
}
