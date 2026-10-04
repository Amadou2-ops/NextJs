# @transfertplus/web — site client

Site client TransfertPlus en Next.js 16 (App Router), conçu comme un
**BFF** (*backend for frontend*) : il est le seul à parler à l'API
`@transfertplus/api`, et le navigateur ne voit jamais aucun jeton.

## Sécurité

| Mesure | Mise en œuvre |
| --- | --- |
| Jetons de l'API côté serveur uniquement | cookie `__Host-tp_session` : JWE `dir` + `A256GCM` (jose), HttpOnly, Secure, SameSite=Strict, Path=/ |
| Rotation de la clé de session | `SESSION_ENCRYPTION_KEY_PREVIOUS` acceptée en lecture ; le cookie est rescellé avec la clé active au renouvellement |
| Étape d'authentification en cours | cookie `__Host-tp_pending` scellé, 10 minutes, usage distinct (`typ`) |
| Renouvellement | dans `src/proxy.ts` avant expiration ; dédupliqué par jeton (jeton de renouvellement à usage unique côté API) |
| CSRF | SameSite=Strict + contrôle de l'en-tête `Origin` sur toute requête non GET (403) + actions serveur |
| CSP | nonce par requête, `strict-dynamic`, `frame-ancestors 'none'`, hôtes tiers explicites (Stripe, Onfido, Smile ID) |
| Redirection ouverte | `safeNextPath` (chemins internes uniquement) ; pages de paiement externes limitées à `trustedPaymentUrl` |
| Adresse du client | lue dans `X-Forwarded-For` au rang `TRUSTED_PROXY_HOPS`, transmise à l'API (limites de débit, audit) |
| Secrets de formulaire | jamais renvoyés au navigateur après une erreur (`SECRET_FIELDS`) |

## Parcours

- `/inscription` → code SMS (`/inscription/confirmation`) → tableau de bord
- `/connexion` → second facteur SMS/TOTP (`/connexion/verification`) ou clé d'accès (WebAuthn)
- `/mot-de-passe-oublie` → code SMS, code TOTP si activé et nouveau mot de passe (`/mot-de-passe-oublie/nouveau`) → connexion
- `/envoyer` : devis en direct, bénéficiaire, transfert (clé d'idempotence `web-<uuid>`), paiement
- `/transferts`, `/transferts/[id]`, `/transferts/[id]/paiement` (Stripe Elements ou page hébergée)
- `/beneficiaires`, `/portefeuille/[devise]`, `/verification` (KYC Onfido / Smile ID), `/securite`
  (sessions, TOTP, clés d'accès)

## Configuration

Voir [`.env.example`](.env.example). La configuration est validée au démarrage
(`src/server/env.ts`) : `APP_ORIGIN` doit être en https en production (sauf
exécution sur localhost).

## Commandes

```bash
pnpm --filter @transfertplus/web dev        # développement (http://localhost:3000)
pnpm --filter @transfertplus/web typecheck
pnpm --filter @transfertplus/web lint
pnpm --filter @transfertplus/web test
pnpm --filter @transfertplus/web build      # sortie autonome (.next/standalone)
```

En production (`pnpm --filter @transfertplus/web start`) : `node .next/standalone/apps/web/server.js` après copie de
`.next/static` (et `public/` s'il existe) dans le dossier autonome.
