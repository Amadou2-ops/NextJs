# @transfertplus/api — API Node.js

API unique servant l'application mobile Flutter, le site web client et le
dashboard d'administration (via leurs serveurs intermédiaires Next.js).

## Architecture

```
src/
  config/      env.ts (validation stricte, règles par environnement), logger.ts (masquage)
  db/          pool.ts (int8 → BigInt, délais de garde), transaction.ts (acteur, rejeu 40001/40P01)
  auth/        accessToken.ts (JWT EdDSA at+jwt), sessions.ts (révocation immédiate),
               permissions.ts (RBAC en base), authContext.ts
  lib/         money.ts (arithmétique exacte, parité avec la base), errors.ts (RFC 9457,
               SQLSTATE → codes métier), idempotency.ts, redis.ts,
               crypto/ (chiffrement d'enveloppe AES-256-GCM, index aveugles, signatures webhooks)
  middlewares/ requestId, securityHeaders, cors (strict + anti-CSRF), rateLimit (Redis + secours),
               jsonBody, authenticate, requirePermission, validate, idempotencyKey, errorHandler
  routes/      system.routes.ts (santé, JWKS)
  app.ts       assemblage (dépendances injectées)
  server.ts    démarrage, délais anti-Slowloris, arrêt propre
```

Les modules métier (authentification, registre, change, KYC, transferts, AML,
administration) se branchent via `createApp({ mountRoutes })` au fil des
phases suivantes.

## Authentification partagée

| Client | Transport du jeton vers l'API |
|---|---|
| Mobile Flutter | `Authorization: Bearer` (jeton `aud=mobile`, lié à l'appareil `did`) |
| Site web client | BFF Next.js côté serveur → `Authorization: Bearer` (`aud=web`) ; le navigateur n'a qu'un cookie `__Host-` |
| Dashboard admin | BFF admin → `Authorization: Bearer` (`aud=admin`, jeu de clés distinct) |

L'API n'accepte aucun jeton par cookie. Chaque jeton est vérifié
cryptographiquement PUIS confronté à sa session en base (révocation immédiate).

## Authentification client (`src/modules/auth`)

| Parcours | Facteurs | Résultat |
|---|---|---|
| Inscription | code SMS (possession du numéro) + mot de passe ; mobile : appareil attesté | session niveau 2 |
| Connexion mobile, appareil connu | mot de passe + requête signée par la clé matérielle | session niveau 2, sans SMS |
| Connexion web ou nouvel appareil | mot de passe → TOTP si activé, sinon code SMS | session niveau 2 |
| Passkey (web) | WebAuthn avec vérification de l'utilisateur | session niveau 2 |
| Renouvellement | jeton opaque à usage unique (+ signature d'appareil sur mobile) | rotation ; réutilisation = révocation de la session |

Garanties principales :

- **Mots de passe** : Argon2id (64 Mio, t = 3), politique de robustesse,
  refus des mots de passe compromis (Have I Been Pwned, k-anonymat),
  verrouillage exponentiel après 5 échecs, temps de réponse constant même
  pour un numéro inconnu.
- **Codes SMS** : 6 chiffres aléatoires, HMAC lié au défi, 5 minutes,
  5 tentatives, 5 envois par numéro sur 15 minutes. Un numéro déjà inscrit
  reçoit un avertissement au lieu d'un code, avec une réponse HTTP identique.
- **Appareils** : la clé publique de l'appareil est liée au défi serveur dans
  l'attestation App Attest (chaîne vers la racine Apple épinglée, nonce,
  App ID, compteur, environnement) ou Play Integrity (requestHash, application
  reconnue, certificat de signature, intégrité de l'appareil). Chaque requête
  sensible est ensuite signée (ES256 / EdDSA) avec un compteur anti-rejeu.
- **TOTP** : RFC 6238, secret chiffré, un pas de temps n'est accepté qu'une
  fois (garanti en base).
- **Passkeys** : clés résidentes, vérification de l'utilisateur exigée,
  origine et domaine vérifiés (résistant à l'hameçonnage), compteur non
  décroissant.
- Chaque événement (inscription, connexion, échec, réutilisation de jeton,
  révocation, activation MFA) est inscrit au journal d'audit chaîné.

L'authentification du personnel (WebAuthn matériel obligatoire) arrive avec
l'API d'administration (phase 9).

## Registre (`src/modules/ledger`, `src/jobs`)

- `LedgerService.post()` : seule porte d'entrée des modules métier vers le
  registre. Les écritures sont typées (`Money`), vérifiées localement
  (équilibre par devise, pas de débit et crédit sur le même compte), puis
  transmises à `ledger.post_journal()`. Les montants voyagent en `bigint[]`
  PostgreSQL et ne deviennent jamais des nombres flottants.
- Routes client : `GET/POST /v1/wallets`, `GET /v1/wallets/{devise}/statement`
  (pagination par curseur). Aucune route n'écrit d'écriture arbitraire.
- Routes personnel (`ledger:read`) : comptes, écritures, journaux avec leurs
  empreintes, balance générale, état d'intégrité.
- Processus `worker` (`pnpm dev:worker`) :
  - **rapprochement** horaire : chaîne d'empreintes (incrémentale, complète au
    moins toutes les 24 h), soldes, balance générale, chaîne d'audit. Toute
    anomalie est historisée et déclenche l'alerte `ledger.integrity_breach`
    (outbox) ;
  - **ancrage RFC 3161** toutes les 6 h du dernier état vérifié sain auprès
    d'une autorité d'horodatage ; le jeton est entièrement vérifié (empreinte,
    nonce, signature CMS, usage timeStamping, chaîne de confiance) puis
    conservé. Vérification indépendante par un auditeur :
    `openssl ts -verify -in jeton.der -token_in -digest <empreinte> -CAfile ca.pem` ;
  - **purge** des clés d'idempotence et défis expirés.
  Chaque tâche est protégée par un verrou consultatif PostgreSQL : plusieurs
  instances du worker peuvent tourner sans exécution concurrente.

## Change (`src/modules/fx`)

- **Collecte des taux** (tâche `fx-refresh` du worker, toutes les 15 min) :
  Open Exchange Rates (`Authorization: Token …`) et Fixer via APILayer
  (en-tête `apikey`), base USD. Le JSON est lu avec le texte exact de chaque
  nombre (jamais de flottant) puis normalisé à 15 décimales. Un taux variant
  de plus de `FX_MAX_JUMP_BPS` par rapport au dernier taux connu (< 24 h) est
  écarté et signalé (outbox `fx.rate_rejected`). Chaque collecte est tracée
  dans `fx.rate_fetches` (immuable).
- **Moteur de devis** (`QuoteService`) : pays d'envoi/réception ouverts,
  devises actives, corridor de paiement disponible, taux du fournisseur
  principal de moins de `FX_MAX_RATE_AGE_MINUTES`, écart avec le second
  fournisseur inférieur à `FX_MAX_DIVERGENCE_BPS` (sinon 503 : aucun taux
  douteux n'est proposé). Taux croisé via USD, marge selon `fx.pricing_rules`,
  frais selon `transfers.fee_schedules` (fixe + pourcentage arrondi au
  supérieur, plancher/plafond, propre au mode de financement), mode « envoi »
  ou « réception » (plus petit montant source garantissant le montant reçu).
- Les calculs (taux client, conversion arrondie vers le bas) sont identiques
  au centime près à ceux de la base : `fx.quotes_validate` refuse tout devis
  incohérent et `transfers_guard` impose au transfert de reprendre le devis à
  l'identique, mode de financement compris.
- Routes : `GET /v1/fx/estimate` (public, limité par IP),
  `POST /v1/quotes` (client actif, devis valable `FX_QUOTE_TTL_SECONDS`),
  `GET /v1/quotes/{id}`.

## KYC (`src/modules/kyc`, `src/modules/webhooks`)

- **Niveaux** : `tier_1` = pièce d'identité + selfie de vivacité ;
  `tier_2` = preuve de domicile (exige `tier_1`) ; `tier_3` = vigilance
  renforcée décidée par la conformité. Le niveau d'un client n'est jamais
  écrit par l'API : la base le relève à l'approbation d'une vérification et
  le recalcule à son expiration (migration 0020).
- **Routage** (`kyc.provider_routes`) : Onfido par défaut ; Smile ID pour les
  résidents d'Afrique (Biometric KYC pour NG, GH, KE, ZA, UG). Un prestataire
  non configuré est sauté au profit de la règle suivante.
- **Parcours** : `POST /v1/kyc/verifications` (identité déclarée à la première
  vérification, chiffrée, figée ensuite) ouvre la session et renvoie les
  paramètres du SDK : jeton du workflow run Onfido, ou paramètres signés
  Smile ID (+ jeton d'intégration web pour le site). `GET /v1/kyc` donne le
  niveau, les plafonds et la prochaine étape.
- **Décision** : le webhook n'est qu'un signal ; le résultat est relu chez le
  prestataire (`GET /workflow_runs/{id}`, `POST /job_status` à réponse
  signée). Une approbation n'est appliquée que si le nom et la date de
  naissance lus sur la pièce concordent avec l'identité déclarée, si le
  client est majeur et si la pièce n'est pas rattachée à un autre client
  (index aveugle du numéro) ; sinon revue manuelle (`in_review`, outbox
  `kyc.review_required`). La base revérifie ces conditions.
- **Onfido Studio** : chaque workflow doit exposer dans sa sortie
  `first_name`, `last_name`, `date_of_birth`, `document_type`,
  `issuing_country` et `document_number` (ou `document_numbers`) ; sans
  elles, la vérification part en revue manuelle.
- **Webhooks** : `POST /v1/webhooks/onfido` (`X-SHA2-Signature`, HMAC-SHA256
  du corps brut) et `POST /v1/webhooks/smile-id` (signature Smile ID +
  horodatage dans la fenêtre de tolérance). Rejet tracé dans
  `integrations.webhook_rejections` ; événement authentifié stocké une fois,
  minimisé (aucune donnée nominative), traité puis repris par le worker en
  cas d'échec (`webhook-retry`, délai croissant, alerte après 10 tentatives).
- **Worker** `kyc-sync` : relit les vérifications ouvertes (webhook perdu),
  expire les sessions abandonnées et les approbations échues.

## Transferts et paiements (`src/modules/transfers`, `src/modules/payments`, `src/modules/recipients`)

- **Bénéficiaires** : nom et coordonnées chiffrés (contexte lié à la ligne),
  index aveugle des coordonnées (doublons, comptes partagés), IBAN validé
  (ISO 13616), numéro mobile du pays du bénéficiaire ; jamais modifiés,
  seulement archivés.
- **Création** (`POST /v1/transfers`, `Idempotency-Key` obligatoire) :
  autorisation renforcée (signature de l'appareil en mobile, code TOTP en
  web) ; la base vérifie le devis, le bénéficiaire et les plafonds KYC
  (opération, 24 h, 30 j, 365 j, sous verrou du client). Portefeuille :
  réservation immédiate. Carte (Stripe PaymentIntent) ou virement / mobile
  money (page Flutterwave) : la réponse contient l'action de paiement ; le
  secret client Stripe n'est jamais stocké.
- **Comptabilité** : réservation `transfer:<id>:funding`, paiement sortant
  `transfer:<id>:payout:<tentative>` (frais, position de change par devise,
  compensation chez le prestataire), règlement, frais prestataires,
  contre-passation en cas d'échec, remboursement `transfer:<id>:refund`. La
  base refuse toute transition de statut non adossée à son écriture ou à sa
  tentative (migration 0021).
- **Routage** : corridor actif le moins prioritaire puis le moins coûteux,
  hors corridors déjà essayés, disjoncteur par prestataire (sonde unique en
  semi-ouvert), trésorerie disponible chez le prestataire vérifiée sous
  verrou (préfinancement − paiements non réglés). Jusqu'à `PAYOUT_MAX_ROUTES`
  routes, puis remboursement automatique (portefeuille ou moyen de paiement
  d'origine).
- **Issue incertaine** (réponse perdue) : jamais de nouvelle route ;
  relecture chez le prestataire (Thunes par identifiant externe, Stripe par
  clé d'idempotence) ou alerte de réconciliation (`payments.outcome_unknown`).
- **Webhooks** : Stripe (`Stripe-Signature`, tolérance 5 min, corps
  entièrement signé), Flutterwave (`verif-hash`, état relu par l'API),
  Thunes (liste blanche facultative, transaction relue). Montants encaissés
  comparés à l'ordre au centime près ; un écart bloque le financement et
  alerte. Paiement tardif sur transfert annulé : compte d'attente + alerte.
  Rétrofacturations Stripe : perte constatée puis contre-passée si gagnée.
- **Worker** `payment-sync` : tentatives restées ouvertes, financements
  expirés (`PAYMENTS_FUNDING_TTL_MINUTES`), paiements sortants et
  remboursements en attente.
- Stripe sert à l'encaissement : un paiement sortant Stripe Connect exigerait
  un compte connecté vérifié par bénéficiaire, inadapté aux particuliers ;
  les paiements sortants passent par Flutterwave et Thunes.

## AML (`src/modules/aml`)

- **Listes** (worker `aml-lists`, toutes les `AML_LISTS_REFRESH_HOURS`) :
  OFAC SDN + noms alternatifs (CSV), liste consolidée ONU (XML), personnes
  politiquement exposées OpenSanctions (CSV, obligatoire en production).
  Chaque import crée une version immuable (empreinte SHA-256) et bascule la
  version courante dans la même transaction ; une liste moins de deux fois
  plus courte que la précédente est refusée (`aml.list_rejected`).
- **Criblage** : présélection par trigrammes (`aml.candidate_names`,
  fonction `SECURITY DEFINER`, aucun accès direct aux listes), puis note
  Jaro-Winkler par jeton (accents, translittérations, particules et ordre des
  noms neutralisés) ajustée par l'année de naissance. Seuil
  `AML_MATCH_THRESHOLD`. Chaque criblage conserve les versions de listes
  consultées et les meilleurs candidats.
- **Évaluation** au financement de chaque transfert : expéditeur et
  bénéficiaire criblés, puis les 11 règles de `aml.rules` (sanctions, PEP,
  listes indisponibles ou de plus de `AML_LISTS_MAX_AGE_HOURS`, pays à
  risque, montant unique, vélocité 1 h / 24 h, fractionnement, bénéficiaire
  partagé, nouvel appareil, aller-retour rapide). Une règle inconnue du code
  fait échouer l'évaluation, jamais l'inverse.
- **Base** (migration 0022) : un transfert ne passe en paiement sortant
  qu'avec une évaluation `clear` ; une alerte bloquante le place en
  `compliance_review`, d'où seul un humain (alerte close comme fausse
  alerte) peut le libérer. Client gelé ou sanctionné : refus `AM001`
  (`COMPLIANCE_BLOCKED`).

## Back-office (`src/modules/backoffice`)

- **Personnel** : invitation à usage unique (jeton de 256 bits, seule son
  empreinte est stockée, lien remis à l'approbateur), enrôlement avec mot de
  passe de 14 caractères minimum et clé WebAuthn liée à l'appareil (passkeys
  synchronisées refusées, liste d'AAGUID facultative). Connexion en deux
  temps : mot de passe (verrouillage après 5 échecs) puis assertion liée au
  défi, au compte et à l'adresse IP. Jetons `aud=admin` de 10 minutes signés
  par une clé distincte des clients, renouvellement à usage unique
  (réutilisation = session révoquée), sessions de 8 h au plus.
- **Contrôle d'accès à chaque requête** : session active, adresse IP dans
  les plages autorisées du membre, permission RBAC lue en base. Une garde de
  préfixe protège toutes les routes `/v1/admin/*`, y compris celles du
  registre ; le module doit être monté en premier.
- **Double validation** (`/v1/admin/approvals`) : invitation, rôles,
  réactivation, réseau, remboursement ordonné, gel de compte, ajustement et
  contre-passation, déclaration de soupçon. Le demandeur ne peut ni approuver
  ni exécuter ; l'approbateur exécute dans la transaction de l'approbation et
  la base vérifie la demande, sa cible et l'exécutant
  (`backoffice.assert_approved`, migration 0023).
- **Décisions humaines vérifiées par la base** : clôture d'alerte, décision
  KYC, mise en revue et libération de transfert, suspension de client,
  dossiers d'enquête (permission de l'acteur et signature à son nom).
- **Données personnelles** : jamais en clair dans les listes et fiches ;
  déchiffrement sur justification (`customers:read_pii`), tracé dans le
  journal d'audit chaîné, consultable et vérifiable (`/v1/admin/audit`).
- **Amorçage** : `BOOTSTRAP_DATABASE_URL=… ADMIN_ENROLLMENT_URL=… pnpm
  admin:bootstrap --email … --name … --ip-range …`, exécuté deux fois, crée
  le binôme fondateur de super-administrateurs (la double validation exige
  deux personnes dès la première invitation) ; connexion propriétaire,
  définitivement fermé après deux comptes ou la première invitation émise
  par un membre (migration 0024).

## Métriques (`src/observability`)

- `METRICS_PORT` (désactivées sans) et `METRICS_HOST` (défaut `127.0.0.1`) :
  serveur interne distinct du port public (`METRICS_PORT` ≠ `PORT`, refusé au
  démarrage sinon), `GET /metrics` seulement, 503 si la collecte échoue.
- API : `transfertplus_http_request_duration_seconds{method,route,status_class}`
  (route = motif Express, `unmatched` sinon : jamais l'URL reçue) et métriques
  du processus Node.js (`transfertplus_process_*`, `transfertplus_nodejs_*`).
- Worker : `transfertplus_job_*{task}` (exécutions, durées, dernier succès,
  période) et indicateurs lus en base à chaque collecte
  (`observability/operationalMetrics.ts`) : registre, listes de sanctions,
  taux de change, webhooks, outbox, transferts, alertes LCB-FT, disjoncteurs.
  Les événements datés sont des horodatages Unix, 0 pour « jamais ».
- Règles d'alerte et exploitation : [`deploy/monitoring/`](../../deploy/monitoring),
  [`deploy/README.md`](../../deploy/README.md#surveillance-et-alertes).

## Tests

Base PostgreSQL réelle (recréée à chaque exécution, `TEST_DATABASE_URL`
en `*_test`), fichiers exécutés en série.

- **Unitaires et HTTP** : chaque module, ses erreurs et ses en-têtes.
- **Propriétés** (`tests/properties.test.ts`, fast-check, graine fixe) :
  conversions mineures ↔ décimales, arrondis de frais, points de base qui ne
  créent jamais d'argent, conversion sous-additive, montant source minimal,
  marge, JSON sans flottants, similarité de noms, CSV. Parité exacte avec
  `fx.convert_minor` et l'arrondi de marge de PostgreSQL sur 1000 cas.
- **Matrice d'autorisation** (`tests/security-matrix.test.ts`) : chaque
  route exposée (énumérée depuis les routeurs montés) est appelée sans
  jeton, avec un jeton de la mauvaise audience et avec un rôle insuffisant ;
  une route ajoutée sans protection fait échouer la suite. Webhooks non
  signés refusés sans écriture.
- **Concurrence** (`tests/concurrency.test.ts`) : requêtes simultanées sans
  double dépense, une seule exécution par clé d'idempotence (la requête
  concurrente rejoue le résultat), devis consommé une seule fois.
- **Intégrité en fin de suite** : chaîne du registre, soldes recalculés,
  balance par devise et chaîne d'audit revérifiés après tous les tests.
- **Couverture** (`pnpm test:coverage`) : seuils bloquants en CI, rapport
  HTML publié comme artefact.

## Commandes

```bash
cp .env.example .env     # puis remplir les clés locales
pnpm dev                 # tsx watch
pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/transfertplus_api_test pnpm test
TEST_DATABASE_URL=… pnpm test:coverage   # avec seuils de couverture
pnpm build && pnpm start          # API
pnpm start:worker                  # tâches de fond
```
