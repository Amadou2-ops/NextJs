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
