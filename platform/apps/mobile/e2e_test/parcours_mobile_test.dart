import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:transfertplus/src/app.dart';
import 'package:transfertplus/src/core/session/secure_store.dart';
import 'package:transfertplus/src/core/session/session_manager.dart';

import 'support/e2e.dart';

/// Parcours de bout en bout de l'application mobile, sur la pile réelle :
///   1. inscription par code SMS : appareil enregistré par attestation App Attest ;
///   2. identité vérifiée (décision du prestataire), portefeuille EUR ouvert
///      depuis l'application (requête signée par la clé de l'appareil) ;
///   3. portefeuille approvisionné, envoi de 100 EUR vers le Sénégal confirmé
///      par la biométrie, remboursé faute de route de paiement sortant ;
///   4. relance de l'application : session reprise par un renouvellement
///      signé, rien d'affiché avant le déverrouillage biométrique.
void main() {
  setUpAll(() async {
    // Réseau réel : le binding de test remplace sinon tout client HTTP.
    HttpOverrides.global = null;
    await initializeDateFormatting('fr_FR');
  });

  testWidgets('inscription, portefeuille, envoi remboursé et reprise de session sur appareil de confiance', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final control = Control();
    final store = MemorySecureStore();
    final keys = RemoteSecureElement(control);
    final authenticator = AcceptingAuthenticator();
    final phone = '+33612${Random.secure().nextInt(900000) + 100000}';
    const password = 'Recette-mobile-2026!';

    // --- 1. Inscription -------------------------------------------------------
    debugPrint('▸ étape 1 : Inscription');
    final since = DateTime.now().subtract(const Duration(seconds: 1));
    final services = buildServices(store: store, keys: keys, authenticator: authenticator);
    await tester.pumpWidget(TransfertPlusApp(services: services));
    // Comme lib/main.dart : la reprise de session tourne pendant l'affichage.
    unawaited(services.session.restore());
    await pumpUntil(tester, find.text('Créer un compte'));
    await tester.tap(find.text('Créer un compte'));
    await pumpUntil(tester, find.widgetWithText(TextFormField, 'Numéro de téléphone mobile'));

    final seen = await real(tester, () => control.smsCount(phone));
    await tester.enterText(find.widgetWithText(TextFormField, 'Numéro de téléphone mobile'), phone);
    await tester.tap(find.textContaining("J'accepte les conditions"));
    await tester.pump();
    await tester.tap(find.text('Recevoir un code par SMS'));
    await pumpUntil(tester, find.widgetWithText(TextFormField, 'Code reçu par SMS'));

    final code = await real(tester, () => control.smsCode(phone, seen));
    await tester.enterText(find.widgetWithText(TextFormField, 'Code reçu par SMS'), code);
    await tester.enterText(find.widgetWithText(TextFormField, 'Mot de passe (10 caractères au moins)'), password);
    await tester.enterText(find.widgetWithText(TextFormField, 'Confirmation du mot de passe'), password);
    await reveal(tester, find.text('Créer mon compte'));
    await tester.tap(find.text('Créer mon compte'));
    await pumpUntil(tester, find.text('Portefeuilles'));
    expect(services.session.status, SessionStatus.signedIn);
    expect(store.values[StoreKeys.deviceId], isNotNull, reason: 'appareil enregistré par attestation');

    // --- 2. Identité vérifiée, portefeuille ouvert depuis l'application --------
    debugPrint('▸ étape 2 : Identité vérifiée, portefeuille ouvert depuis l’application');
    final userId = await real(tester, () => control.approveKyc(since));
    expect(find.text('Aucun portefeuille ouvert.'), findsOneWidget);
    await tester.tap(find.text('Ouvrir un portefeuille'));
    await pumpUntil(tester, money('0,00 €'));
    expect(find.text('Aucun portefeuille ouvert.'), findsNothing);

    // --- 3. Approvisionnement, envoi, remboursement --------------------------
    debugPrint('▸ étape 3 : Approvisionnement, envoi, remboursement');
    await real(tester, () => control.creditWallet(userId, 'EUR', '25000'));
    await tester.fling(find.byType(Scrollable).first, const Offset(0, 400), 1000);
    await pumpUntil(tester, money('250,00 €'));

    await tester.tap(find.text('Envoyer'));
    await pumpUntil(tester, find.text('Voir le devis'));
    await tester.enterText(find.widgetWithText(TextField, 'Montant à envoyer'), '100');
    await tester.tap(find.widgetWithText(InputDecorator, 'Moyen de paiement'));
    await settle(tester);
    await tester.tap(find.text('Solde du portefeuille').last);
    await settle(tester);
    await tester.tap(find.text('Voir le devis'));
    await pumpUntil(tester, find.text('Le bénéficiaire reçoit'));
    expect(find.textContaining('101,99'), findsWidgets);

    await reveal(tester, find.text('Nouveau bénéficiaire'));
    await tester.tap(find.text('Nouveau bénéficiaire'));
    await pumpUntil(tester, find.text('Enregistrer le bénéficiaire'));
    await tester.enterText(find.widgetWithText(TextFormField, 'Prénom'), 'Moussa');
    await tester.enterText(find.widgetWithText(TextFormField, 'Nom'), 'Ba');
    await tester.enterText(find.widgetWithText(TextFormField, 'Numéro de téléphone du bénéficiaire'), '+221776543210');
    await reveal(tester, find.widgetWithText(InputDecorator, 'Opérateur'));
    await tester.tap(find.widgetWithText(InputDecorator, 'Opérateur'));
    await settle(tester);
    await tester.tap(find.text('Orange Money').last);
    await settle(tester);
    await reveal(tester, find.text('Enregistrer le bénéficiaire'));
    await tester.tap(find.text('Enregistrer le bénéficiaire'));
    await pumpUntil(tester, find.text('Moussa Ba'));

    final confirm = find.textContaining('Confirmer et envoyer');
    await reveal(tester, confirm);
    await tester.tap(confirm);
    // Le paiement sortant est déclenché après la réponse : aucune route n'étant configurée, le transfert est remboursé.
    await pumpUntil(tester, find.text('Remboursé'), timeout: const Duration(seconds: 60));
    expect(authenticator.reasons.where((reason) => reason.startsWith("Confirmez l'envoi")), hasLength(1));

    // --- 4. Relance : session reprise sur l'appareil de confiance ------------
    debugPrint('▸ étape 4 : Relance : session reprise sur l’appareil de confiance');
    await tester.pumpWidget(const SizedBox.shrink());
    final relaunched = buildServices(store: store, keys: keys, authenticator: authenticator);
    await tester.pumpWidget(TransfertPlusApp(services: relaunched));
    unawaited(relaunched.session.restore());
    // Déverrouillage biométrique (accepté), puis accueil : le remboursement a rendu le solde.
    await pumpUntil(tester, find.text('Portefeuilles'));
    expect(relaunched.session.status, SessionStatus.signedIn, reason: 'renouvellement signé par la clé de l\'appareil');
    await pumpUntil(tester, money('250,00 €'));
    expect(authenticator.reasons, contains('Déverrouillez TransfertPlus'));

    // Fermeture : les connexions HTTP inactives (keep-alive, 15 s) se libèrent.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 16));
  });
}
