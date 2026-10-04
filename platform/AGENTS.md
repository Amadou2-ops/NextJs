# Consignes pour `platform/`

Ces règles s'appliquent à tout le code sous `platform/` (l'app Expo à la racine
du dépôt suit le `AGENTS.md` racine).

- Gestionnaire de paquets : `pnpm` (espace de travail). Node.js 22, TypeScript strict
  (`tsconfig.base.json`, aucun `any`).
- **Montants** : toujours des entiers en unités mineures (`bigint` en SQL,
  `bigint`/chaîne en TypeScript, `String` dans les échanges JSON). Jamais de
  `number` flottant pour de l'argent.
- **Registre** : aucune écriture directe dans `ledger.*`. Uniquement
  `ledger.post_journal()` / `ledger.reverse_journal()` avec une clé d'idempotence
  déterministe (ex. `transfer:<id>:hold`).
- **Migrations** : ne jamais modifier une migration existante ; ajouter
  `db/migrations/NNNN_nom.sql`. Toute nouvelle table doit recevoir ses privilèges
  explicites et la RLS (voir `0016_roles_grants_rls.sql`).
- Les données de référence `db/seed/0001` et `0002` sont générées :
  `pnpm --filter @transfertplus/db generate:reference`.
- Avant de livrer : `pnpm --filter @transfertplus/db typecheck` et `pnpm db:test`.

## API (`apps/api`)

- Architecture en couches : routes → contrôleurs → services → dépôts (SQL). Les
  contrôleurs ne lisent que `req.validated` (middleware `validate`, schémas Zod
  stricts), jamais `req.body` brut.
- Toute écriture passe par `withTransaction(pool, { actor }, …)`. Aucun effet
  externe (prestataire, e-mail) dans une transaction : utiliser l'outbox.
- Toute route mutatrice : `authenticate` → `validate` → `requireIdempotency`.
  Routes du personnel : `authenticate(…, ["admin"])` → `requirePermission`.
- Erreurs : lever une `AppError` (ou laisser remonter l'erreur PostgreSQL, traduite
  par `toAppError`). Ajouter un code d'erreur = l'ajouter aussi au contrat OpenAPI
  (un test vérifie la concordance).
- Routes mobiles sensibles : ajouter `requireDeviceSignature` après `authenticate`.
- Mouvements comptables : uniquement via `LedgerService.post()` / `reverse()` dans une
  `withTransaction`, avec une clé d'idempotence déterministe dérivée de l'opération.
- Toute nouvelle route doit figurer dans `packages/contracts/openapi.yaml`
  (un test vérifie la couverture des routes du module d'authentification).
- Avant de livrer : `pnpm --filter @transfertplus/api typecheck`, `lint`, `test`
  (`TEST_DATABASE_URL` vers une base `*_test`).

## Site client (`apps/web`)

- Next.js 16 (App Router, `src/proxy.ts` remplace le middleware). Le navigateur
  ne détient jamais de jeton de l'API : uniquement le cookie chiffré
  `__Host-tp_session` (JWE). Tout appel à l'API se fait côté serveur
  (`src/server/*`, marqués `server-only`).
- Mutations : actions serveur + `useActionState`, entrée lue par `parseForm`
  (schéma Zod strict), erreurs via `fromError` (jamais de détail technique).
  Ne jamais renvoyer un champ secret au navigateur (`SECRET_FIELDS`).
- Redirections : uniquement des chemins internes (`safeNextPath`) ; URL de
  paiement externe uniquement via `trustedPaymentUrl`.
- Montants : chaînes en unités mineures, conversion via `src/lib/format.ts`.
- Aucun script ou style inline hors nonce CSP ; nouvel hôte tiers = l'ajouter
  à `contentSecurityPolicy` (`src/proxy.ts`).
- Avant de livrer : `pnpm --filter @transfertplus/web typecheck`, `lint`, `test`, `build`.
