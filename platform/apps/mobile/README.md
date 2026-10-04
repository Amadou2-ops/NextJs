# TransfertPlus — application mobile (Flutter)

Application iOS / Android du client. Elle parle directement à l'API
(`/v1/*`) ; chaque opération sensible est **signée par une clé matérielle**
de l'appareil.

## Sécurité

| Mesure | Mise en œuvre |
| --- | --- |
| Clé de l'appareil | P-256 générée dans la **Secure Enclave** (iOS) ou l'**Android Keystore** (StrongBox si disponible), non exportable, jamais sauvegardée — `ios/Runner/AppDelegate.swift`, `android/…/DeviceSecurityChannel.kt` |
| Attestation | **App Attest** (iOS) / **Play Integrity** standard (Android), liée au défi serveur et à la clé : `SHA-256(défi ‖ SHA-256(clé publique SPKI))` |
| Signature des requêtes | `TPv1\nMÉTHODE\nchemin?requête\nhorodatage\ncompteur\nbase64url(SHA-256(corps))`, ECDSA DER ; compteur strictement croissant persisté avant l'envoi ; corps signé = corps envoyé (`lib/src/core/security/request_signer.dart`, testé contre des vecteurs produits par le code de l'API) |
| Second facteur | Appareil de confiance : la signature matérielle ; nouvel appareil : code SMS ou TOTP |
| Jetons | Accès (10 min) en mémoire seulement ; renouvellement à usage unique dans le Keychain / Keystore (`unlocked_this_device`, sans sauvegarde), renouvellement signé et dédupliqué |
| Verrou | Biométrie ou code de l'appareil au démarrage, après 60 s en arrière-plan, et pour confirmer chaque transfert et chaque action de sécurité |
| Confidentialité | `FLAG_SECURE` (Android), écran masqué dans le sélecteur d'applications, aucune sauvegarde (`allowBackup=false`, règles d'extraction) |
| Réseau | TLS uniquement, autorités système seulement (`network_security_config.xml`) ; clair toléré uniquement vers l'émulateur en débogage |
| Paiement | Stripe PaymentSheet (3-D Secure) ou page hébergée Flutterwave ouverte dans le navigateur système, hôtes en liste blanche |
| Transfert | Clé d'idempotence conservée entre les tentatives : un nouvel essai rejoue le même transfert, jamais un second |

## Configuration (`--dart-define`)

| Variable | Rôle |
| --- | --- |
| `API_BASE_URL` | Origine de l'API (https, sans chemin ; http accepté seulement pour l'émulateur en débogage) |
| `PLAY_INTEGRITY_CLOUD_PROJECT` | Numéro du projet Google Cloud lié à Play Integrity (Android) |
| `SMILE_ID_PARTNER_ID`, `SMILE_ID_AUTH_TOKEN` | Configuration du SDK Smile ID (portail partenaire) |
| `SMILE_ID_SANDBOX` | `true` en recette uniquement (refusé dans une version de production) |

Côté API : `APPLE_APP_ATTEST_APP_IDS` (`ÉQUIPE.com.transfertplus.app`),
`ANDROID_PACKAGE_NAME=com.transfertplus.app`, `ANDROID_SIGNING_CERT_SHA256`,
`GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT`.

## Commandes

```bash
flutter pub get --enforce-lockfile
flutter analyze --fatal-infos
flutter test
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080      # émulateur Android, API locale
flutter build appbundle --release --obfuscate --split-debug-info=build/symbols \
  --dart-define=API_BASE_URL=https://api.transfertplus.com --dart-define=PLAY_INTEGRITY_CLOUD_PROJECT=…
flutter build ipa --release --obfuscate --split-debug-info=build/symbols --dart-define=API_BASE_URL=https://api.transfertplus.com
```

Signature Android de production : `android/key.properties` (jamais versionné :
`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) ; sans ce fichier, un
build de production échoue au lieu d'être signé avec la clé de débogage.

L'attestation n'existe pas sur les simulateurs et émulateurs sans services
Google : l'enregistrement d'un appareil y est refusé (aucun repli logiciel).
