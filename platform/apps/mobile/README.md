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
flutter test                                                      # tests unitaires et de widgets
# Parcours de bout en bout (application réelle contre la pile réelle) : voir e2e/README.md
#   E2E_SUITE=mobile pnpm --filter @transfertplus/e2e e2e
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

## Publication (Google Play, TestFlight)

La publication passe par le workflow `platform-mobile-release`, qui lance
`fastlane` (`fastlane/Fastfile`, versions figées par `Gemfile.lock`) :

1. Monter la version dans `pubspec.yaml` (`version: X.Y.Z+N`). Le numéro de
   build est attribué par la CI : `MOBILE_BUILD_NUMBER_BASE` + numéro
   d'exécution, strictement croissant.
2. `git tag mobile-vX.Y.Z && git push origin mobile-vX.Y.Z`. L'étiquette doit
   correspondre à `pubspec.yaml`, sinon la publication est refusée. On peut aussi
   lancer le workflow à la main en choisissant les plateformes, la piste Play et le statut.
3. Après l'analyse et les tests, la CI produit et publie :
   - un **AAB** signé avec la clé d'envoi, sur la piste Play choisie (interne par défaut) ;
   - une **IPA** de distribution App Store, sur TestFlight.

   Les symboles de déchiffrement du code obscurci sont archivés 90 jours.

Avant tout envoi, chaque lane vérifie ce qu'elle publie :
- **Android** : le certificat de signature de l'AAB doit être celui de la clé d'envoi (`ANDROID_UPLOAD_CERT_SHA256`).
- **iOS** : le profil doit être un profil de distribution App Store pour `<TEAM_ID>.com.transfertplus.app`. Il doit inclure App Attest de production et rester valable plus de 7 jours.
- **Les deux** : `API_BASE_URL` doit être en https.

### Mise en place (une fois)

**Google Play**

1. Créer l'application `com.transfertplus.app` dans la Play Console et activer
   Play App Signing (Google conserve la clé de signature de l'application).
2. Générer la **clé d'envoi** (conservée hors du dépôt, dans le coffre) :
   ```bash
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 9125
   keytool -list -v -keystore upload.jks -alias upload | grep SHA256   # → ANDROID_UPLOAD_CERT_SHA256
   ```
3. Google exige que le **premier AAB** soit envoyé à la main dans la Play
   Console. Les versions suivantes passent par la CI ; tant que l'application
   n'a jamais été publiée, utiliser le statut `draft`.
4. Créer un compte de service Google Cloud avec une clé JSON. L'inviter dans la Play Console (*Utilisateurs et autorisations*) avec le droit de publier sur les pistes de test.
5. Dans *Intégrité de l'application* :
   - lier le projet Google Cloud de Play Integrity ;
   - reporter l'empreinte du certificat de **signature de l'application** dans `ANDROID_SIGNING_CERT_SHA256` côté API (voir `deploy/PRESTATAIRES.md`).

**App Store Connect**

1. App ID `com.transfertplus.app` avec la capacité **App Attest**.
2. Créer l'application dans App Store Connect.
3. Certificat **Apple Distribution** exporté en `.p12` protégé par mot de passe.
4. Profil de provisionnement **App Store** pour cet App ID. Le régénérer après toute modification des capacités.
5. Clé d'API App Store Connect (rôle *App Manager*) : fichier `.p8`, identifiant de clé, identifiant d'émetteur.

### Environnement GitHub `mobile-release`

À créer dans *Settings → Environments*, avec des relecteurs requis : chaque publication attend une approbation.

| Secret | Contenu |
| --- | --- |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | `base64 -w0 upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Magasin et clé d'envoi |
| `PLAY_SERVICE_ACCOUNT_JSON` | Clé JSON du compte de service de publication |
| `IOS_DISTRIBUTION_CERT_P12_BASE64`, `IOS_DISTRIBUTION_CERT_PASSWORD` | Certificat Apple Distribution |
| `IOS_PROVISIONING_PROFILE_BASE64` | `base64 -i profil.mobileprovision` |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` | Clé d'API App Store Connect |
| `SMILE_ID_AUTH_TOKEN` | Jeton du SDK Smile ID (si Smile ID est utilisé) |

| Variable | Contenu |
| --- | --- |
| `MOBILE_API_BASE_URL` | `https://api.transfertplus.com` |
| `ANDROID_UPLOAD_CERT_SHA256` | Empreinte SHA-256 de la clé d'envoi (`AB:CD:…`) |
| `APPLE_TEAM_ID` | Identifiant d'équipe Apple (10 caractères) |
| `PLAY_INTEGRITY_CLOUD_PROJECT` | Numéro du projet Google Cloud lié à Play Integrity |
| `SMILE_ID_PARTNER_ID`, `SMILE_ID_SANDBOX` | Smile ID (`SMILE_ID_SANDBOX=false` : une version publiée refuse l'environnement de test) |
| `MOBILE_BUILD_NUMBER_BASE` | Facultatif : décalage du numéro de build, si des versions ont déjà été envoyées à la main |

En local, `bundle install` puis `bundle exec fastlane android internal` (ou
`ios beta`) avec les mêmes variables d'environnement. La lane iOS règle la
signature manuelle dans `Runner.xcodeproj` : à n'exécuter qu'en CI ou sur une
copie de travail jetable.
