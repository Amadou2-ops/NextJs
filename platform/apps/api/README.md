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

## Commandes

```bash
cp .env.example .env     # puis remplir les clés locales
pnpm dev                 # tsx watch
pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/transfertplus_api_test pnpm test
pnpm build && pnpm start          # API
pnpm start:worker                  # tâches de fond
```
