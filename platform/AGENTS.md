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

## Back-office (`apps/admin`)

- Même architecture BFF que `apps/web` (cookie `__Host-tpa_session`, clé de
  chiffrement distincte). Seules les routes `/v1/admin/*` sont atteignables.
- L'interface masque ce que le membre ne peut pas faire (`can(admin, …)`),
  mais l'API et la base revérifient tout : ne jamais considérer le masquage
  comme un contrôle d'accès.
- Arguments liés aux actions (`.bind`) : ils transitent par le navigateur,
  les revalider (`validId`, listes fermées) dans l'action.
- Une action renvoyant une valeur à usage unique (lien d'enrôlement) la place
  dans `ActionResult.secret` : la page n'est alors pas rafraîchie, pour ne
  pas perdre la valeur.
- Aucun script, style ni hôte tiers : la CSP n'autorise que `'self'` et le nonce.
- Avant de livrer : `pnpm --filter @transfertplus/admin typecheck`, `lint`, `test`, `build`.

## Application mobile (`apps/mobile`)

- Flutter (Dart strict : `strict-casts`, `strict-inference`, `strict-raw-types`).
  Avant de livrer : `flutter analyze --fatal-infos` et `flutter test`.
- Les dossiers `android/` et `ios/` sont du code source (canal natif
  `com.transfertplus/device_security`) : ils sont versionnés.
- Toute route que l'API protège par `requireDeviceSignature` est appelée avec
  `signed: true`. Ne jamais modifier le message canonique sans mettre à jour
  les vecteurs de `test/signing_test.dart` (générés depuis le code de l'API).
- Montants : `Money` (chaîne en unités mineures) et `lib/src/core/format/money.dart` ;
  jamais de `double` pour de l'argent.
- Aucun secret en clair hors du stockage sécurisé ; aucun repli logiciel si
  la Secure Enclave, le Keystore ou l'attestation sont indisponibles.
