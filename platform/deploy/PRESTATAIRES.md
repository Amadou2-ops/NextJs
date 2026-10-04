# Comptes prestataires : ouverture, contrôle et passage en production

Ordre conseillé : tout ouvrir d'abord en **sandbox** sur un environnement
`staging` (même pile que la production), valider les parcours de bout en bout,
puis refaire chaque étape en **live** pour la production. Les identifiants live
ne vont jamais dans un environnement de test : la configuration de l'API refuse
une clé de test en production (et inversement pour Onfido, Smile ID, Stripe,
Flutterwave).

Toutes les variables citées vont dans `deploy/env/api.env` (identifiants) ; les
valeurs ne sont jamais versionnées.

## Contrôle automatique

Après chaque ouverture ou rotation d'identifiants, depuis le serveur :

```bash
docker compose -f deploy/compose.production.yaml --env-file deploy/env/edge.env run --rm --no-deps \
  api dist/cli/checkProviders.js --api-url https://api.transfertplus.example
```

Chaque prestataire configuré est interrogé **en lecture seule** avec les
identifiants de l'API. Aucun secret n'apparaît dans le rapport.

| Prestataire | Vérifié automatiquement | À vérifier à la main |
| --- | --- | --- |
| Stripe | clé acceptée ; endpoint de webhook actif vers `/v1/webhooks/stripe` ; événements abonnés ; pas d'endpoint en double | secret de signature (non restitué par Stripe) : contrôlé à la réception du premier événement |
| Flutterwave | clé acceptée ; portefeuilles existants | URL de webhook et « secret hash » (tableau de bord seulement) |
| Thunes | identifiants acceptés ; compte de préfinancement dans `THUNES_SETTLEMENT_CURRENCY` ; `THUNES_CALLBACK_URL` dirigée vers l'API | — |
| Onfido | jeton accepté ; webhook actif vers `/v1/webhooks/onfido`, événement `workflow_run.completed`, bon environnement, **jeton identique** à `ONFIDO_WEBHOOK_TOKEN` | — |
| Smile ID | `SMILE_ID_CALLBACK_URL` dirigée vers l'API | identifiants : un parcours KYC de test (aucune lecture sans effet n'existe) |
| Open Exchange Rates / Fixer | identifiant actif ; taux reçus | — |
| Twilio | compte actif, hors essai ; Messaging Service présent | réception d'un SMS réel |
| Play Integrity | compte de service autorisé pour le paquet (projet lié, API activée) | — |
| App Attest | App ID configurés, environnement de production | — |
| Horodatage RFC 3161 | jeton émis et **vérifié** (signature, chaîne de confiance) | — |

Exécution :

- **Codes de sortie** : `0` si aucun échec, `1` sinon.
- **`--strict`** : les avertissements, comme les points à vérifier à la main, deviennent bloquants.
- **`--json`** : produit un rapport exploitable par la supervision.
- **Réponse non JSON** : signale un proxy ou un pare-feu sortant, pas un refus du prestataire.

## Stripe (paiement par carte)

1. Activer le compte (identité de l'entreprise, compte bancaire) ; travailler
   d'abord en **mode test**.
2. Récupérer les clés dans *Developers → API keys* :
   - clé secrète : `STRIPE_SECRET_KEY`. Une clé restreinte est possible avec les droits PaymentIntents et Refunds en écriture, et Webhook Endpoints en lecture pour le contrôle ;
   - clé publiable : `STRIPE_PUBLISHABLE_KEY`.
3. Créer l'endpoint *Developers → Webhooks* :
   - URL `https://api.…/v1/webhooks/stripe` ;
   - version d'API égale à `STRIPE_API_VERSION` ;
   - événements :
     - `payment_intent.succeeded`, `payment_intent.payment_failed`,
       `payment_intent.canceled`, `payment_intent.processing`,
       `payment_intent.requires_action` ;
     - `refund.updated` ;
     - `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`.
4. Copier le secret de signature de l'endpoint dans `STRIPE_WEBHOOK_SECRET`.
   Un seul endpoint par URL : un endpoint en double serait rejeté, car son secret diffère.
5. Tests : carte `4242 4242 4242 4242`, puis `4000 0027 6000 3184` (3-D Secure exigé).
6. Passage en production : refaire les étapes 2 à 4 en mode **live**. L'endpoint et le secret live sont distincts de ceux du mode test.

## Flutterwave (virement, mobile money, paiements sortants)

1. Activer le compte marchand ; clés de test `FLWSECK_TEST-…-X` →
   `FLUTTERWAVE_SECRET_KEY`.
2. Générer un secret de webhook (`openssl rand -hex 32`), le déclarer comme
   « secret hash » dans *Settings → Webhooks* et dans `FLUTTERWAVE_WEBHOOK_HASH`.
   URL du webhook : `https://api.…/v1/webhooks/flutterwave`.
3. `FLUTTERWAVE_REDIRECT_URL` : page de retour du site (`https://app.…/…`).
4. Si la liste blanche d'adresses IP est activée sur le compte, y déclarer
   l'adresse de sortie du serveur. Les paiements sortants depuis une autre adresse sont refusés.
5. Production : clés live, même procédure (le secret hash est propre à chaque mode).

## Thunes (paiements sortants internationaux)

1. Contrat et compte : Thunes fournit l'URL d'API sandbox (`THUNES_BASE_URL`),
   la clé et le secret (`THUNES_API_KEY`, `THUNES_API_SECRET`).
2. Compte de préfinancement dans la devise de règlement
   (`THUNES_SETTLEMENT_CURRENCY`, USD par défaut), alimenté avant les premiers
   paiements.
3. `THUNES_CALLBACK_URL=https://api.…/v1/webhooks/thunes` (transmise à chaque
   transaction) ; demander à Thunes ses adresses d'émission des rappels pour
   `THUNES_CALLBACK_ALLOWED_IPS` (obligatoire en production : les rappels Thunes ne sont pas signés), et lui communiquer l'adresse de sortie du
   serveur si l'accès à l'API est filtré.
4. Production : nouvelles URL et identifiants live fournis par Thunes.

## Onfido (KYC, prioritairement hors Afrique)

1. Choisir la région de stockage des données (`ONFIDO_REGION` : `eu`, `us`, `ca`).
2. Jeton d'API sandbox `api_sandbox…` → `ONFIDO_API_TOKEN`.
3. Dans Onfido Studio, créer les workflows :
   - vérification de document et biométrie : son identifiant va dans `ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION` ;
   - justificatif de domicile, si utilisé : son identifiant va dans `ONFIDO_WORKFLOW_PROOF_OF_ADDRESS`.
4. Webhook :
   - URL `https://api.…/v1/webhooks/onfido` ;
   - événement `workflow_run.completed` ;
   - environnement sandbox.
5. Copier le jeton du webhook dans `ONFIDO_WEBHOOK_TOKEN`.
6. Production : jeton `api_live…` et nouveau webhook avec l'environnement **live**. Le jeton du webhook change.

## Smile ID (KYC, Afrique)

1. Portail partenaire : identifiant partenaire (`SMILE_ID_PARTNER_ID`), clé
   d'API sandbox (`SMILE_ID_API_KEY`), `SMILE_ID_ENVIRONMENT=sandbox`.
2. `SMILE_ID_CALLBACK_URL=https://api.…/v1/webhooks/smile-id`.
3. Application mobile : variables de compilation `SMILE_ID_PARTNER_ID`,
   `SMILE_ID_AUTH_TOKEN`, `SMILE_ID_SANDBOX` (voir `apps/mobile/README.md`).
4. Valider par une vérification de test de bout en bout : c'est le seul moyen
   de prouver les identifiants.
5. Production : clé live et `SMILE_ID_ENVIRONMENT=production`.

## Taux de change

Configurer au moins un fournisseur, idéalement les deux, pour le contrôle de divergence :

- **Open Exchange Rates** : identifiant d'application dans `OPEN_EXCHANGE_RATES_APP_ID`. L'offre doit permettre une mise à jour au moins horaire.
- **Fixer (APILayer)** : `FIXER_API_KEY`. La base USD exige une offre payante.

`FX_PRIMARY_PROVIDER` désigne la source principale.

## SMS (Twilio)

1. Compte **mis à niveau** : un compte d'essai n'envoie qu'aux numéros vérifiés, et le contrôle le refuse en production.
2. Créer un Messaging Service avec les émetteurs autorisés par pays (numéros ou identifiant alphanumérique).
3. Reporter `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` et `TWILIO_MESSAGING_SERVICE_SID`, avec `SMS_PROVIDER=twilio`.

## Attestation des appareils

- **Android (Play Integrity)** :
  - Play Console → *Intégrité de l'application* : lier un projet Google Cloud, y activer l'API Play Integrity ;
  - créer dans ce projet un compte de service et sa clé JSON → `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT` ;
  - `ANDROID_PACKAGE_NAME=com.transfertplus.app` ;
  - `ANDROID_SIGNING_CERT_SHA256` : empreinte SHA-256 du certificat de **signature de l'application**, celui de Play App Signing, pas la clé d'envoi. La convertir en base64url :
    ```bash
    echo 'AB:CD:…' | tr -d ':' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
    ```
  - numéro du projet Google Cloud → variable de compilation `PLAY_INTEGRITY_CLOUD_PROJECT` de l'application.
- **iOS (App Attest)** :
  - capacité App Attest activée sur l'App ID `com.transfertplus.app` ;
  - `APPLE_APP_ATTEST_APP_IDS=<TEAM_ID>.com.transfertplus.app` ;
  - `APPLE_APP_ATTEST_ALLOW_DEVELOPMENT=false` hors développement.

## Horodatage RFC 3161 (ancrage du registre)

Choisir une autorité d'horodatage, de préférence qualifiée eIDAS :

- son URL va dans `TSA_URL` ;
- son certificat ou sa chaîne PEM va dans `deploy/secrets/tsa-ca.pem`, monté en `TSA_TRUSTED_CERTS_PATH`.

Le contrôle demande un jeton réel et le vérifie entièrement.

## Validation de bout en bout (staging, sandbox)

1. `checkProviders.js --strict` : seuls les points à vérifier à la main restent signalés. Les contrôler, puis noter le résultat.
2. Inscription avec un vrai numéro (SMS reçu), connexion, ajout d'une clé d'accès.
3. KYC Onfido et Smile ID avec les documents de test des prestataires. Le niveau KYC doit être accordé par la base à la réception du webhook.
4. Transfert payé par carte 3-D Secure (Stripe), puis par Flutterwave. Le paiement sortant passe par Thunes ou Flutterwave sandbox. Vérifier le statut final et les écritures du registre (back-office → Registre, intégrité « Sain »).
5. Remboursement ordonné depuis le back-office (double validation).
6. Application mobile sur appareil réel, avec un build de développement visant le staging.
   - iOS : build installé depuis Xcode. L'environnement App Attest est fixé à *production* par `Runner.entitlements`, et l'API de staging l'accepte comme la production.
   - Android : Play Integrity ne reconnaît que les applications installées depuis Google Play. L'attestation Android se valide donc à la bascule, avec la piste interne.

## Bascule en production

- [ ] Identifiants live dans `deploy/env/api.env` de production uniquement.
- [ ] Webhooks live déclarés : Stripe, Flutterwave, Onfido. URL de rappel Thunes et Smile ID dirigées vers l'API de production.
- [ ] `checkProviders.js --strict` exécuté sur la production. Les points à vérifier à la main sont validés.
- [ ] Compte Thunes préfinancé ; soldes Flutterwave suffisants pour les paiements sortants.
- [ ] Application publiée sur la piste interne Google Play et sur TestFlight (`apps/mobile/README.md`, section Publication). Les versions publiées visent l'API de production et refusent les environnements de test des prestataires. Vérifier l'attestation sur un appareil réel par plateforme avant d'ouvrir au public.
- [ ] Premier transfert réel de faible montant suivi jusqu'à la livraison, puis remboursé si nécessaire.
