# TransfertPlus 💸

Application mobile de transfert d’argent construite avec **React Native** (Expo SDK 57,
Expo Router, TypeScript).

## Fonctionnalités

- **Création de compte / connexion** par numéro de téléphone + code PIN à 4 chiffres
  (bonus de bienvenue de 50 000 FCFA pour tester).
- **Accueil** : solde (masquable), actions rapides, transactions récentes.
- **Envoyer de l’argent** : choix d’un contact ou saisie d’un numéro, montants rapides,
  motif, calcul des frais (1 %) et du total débité.
- **Confirmation par code PIN** avec clavier dédié (3 tentatives maximum).
- **Reçu** détaillé pour chaque transaction (référence, frais, date…).
- **Recevoir** : affiche votre numéro, avec une réception simulée pour la démo.
- **Recharger** le compte (carte, mobile money, agent).
- **Historique** filtrable (envoyés / reçus / dépôts) avec total des entrées et sorties.
- **Profil** : statistiques, déconnexion, réinitialisation.
- Données persistées localement avec AsyncStorage.

## Démarrer

```bash
npm install
npm start          # puis scannez le QR code avec Expo Go (Android / iOS)
npm run android    # émulateur Android
npm run ios        # simulateur iOS (macOS)
npm run web        # dans le navigateur
npm run typecheck  # vérification TypeScript
```

## Structure

```
src/
  app/                  # écrans (Expo Router : un fichier = une route)
    _layout.tsx         # navigation racine + protection des routes (connecté / non connecté)
    login.tsx           # inscription / connexion
    (tabs)/             # onglets : Accueil, Historique, Profil
    send.tsx            # formulaire d’envoi
    confirm.tsx         # récapitulatif + saisie du PIN
    receipt/[id].tsx    # reçu d’une transaction
    receive.tsx         # recevoir de l’argent
    topup.tsx           # recharger le compte
  components/           # Button, PinPad, TransactionItem
  context/WalletContext.tsx  # état du portefeuille (solde, transactions, contacts)
  lib/format.ts         # montants, frais, validations
  theme.ts              # couleurs et espacements
```

Les règles métier (devise, taux de frais, montants min/max) se trouvent dans
`src/lib/format.ts`.

## ⚠️ Avant une mise en production

Cette version est une **démo autonome** : l’argent est fictif et tout est stocké sur
l’appareil. Pour de vrais transferts, il faudra notamment :

- un **backend** (API + base de données) qui tient les soldes et exécute les transferts
  de manière atomique ;
- l’intégration d’un **fournisseur de paiement** / mobile money agréé ;
- stocker le PIN côté serveur (haché) ou utiliser `expo-secure-store` et la biométrie
  (`expo-local-authentication`) plutôt qu’AsyncStorage ;
- la vérification d’identité (KYC), des plafonds et la journalisation des opérations.
