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

## Commandes

```bash
cp .env.example .env     # puis remplir les clés locales
pnpm dev                 # tsx watch
pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/transfertplus_api_test pnpm test
pnpm build && pnpm start
```
