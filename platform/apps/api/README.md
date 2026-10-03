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

## Commandes

```bash
cp .env.example .env     # puis remplir les clés locales
pnpm dev                 # tsx watch
pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/transfertplus_api_test pnpm test
pnpm build && pnpm start
```
