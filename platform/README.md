# TransfertPlus — plateforme de transfert d'argent international

Monorepo de l'infrastructure : API Node.js (TypeScript), site web client et
dashboard d'administration (Next.js), application mobile (Flutter), base
PostgreSQL (Supabase) avec registre comptable en partie double.

> L'application de démonstration Expo historique reste à la racine du dépôt,
> indépendante de cette plateforme.

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| 0 | Monorepo, configuration, CI, contrat OpenAPI de base | ✅ |
| 1 | Base de données : 16 migrations, données de référence, tests | ✅ |
| 2 | Cœur de l'API (config, erreurs, middlewares de sécurité) | ✅ |
| 3 | Authentification client (JWT EdDSA, sessions, appareils attestés, MFA, passkeys) | ✅ |
| 4 | Registre côté API : portefeuilles, relevés, rapprochement, ancrage RFC 3161 | ✅ |
| 5 | Taux de change (Fixer, Open Exchange Rates), devis | à venir |
| 6 | KYC (Smile ID, Onfido) et webhooks signés | à venir |
| 7 | Routage des paiements (Stripe Connect, Flutterwave, Thunes) | à venir |
| 8 | AML : règles, criblage, dossiers | à venir |
| 9 | API d'administration (RBAC, double validation) | à venir |
| 10 | Tests de l'API | à venir |
| 11 | Site web client (Next.js, BFF) | à venir |
| 12 | Dashboard admin (Next.js, WebAuthn) | à venir |
| 13 | Application mobile Flutter | à venir |
| 14 | Déploiement et exploitation | à venir |

## Démarrage local

Prérequis : Node.js 22, pnpm 10, Docker.

```bash
cd platform
cp .env.example .env            # valeurs locales uniquement
docker compose up -d            # PostgreSQL 17 + Redis, liés à 127.0.0.1
pnpm install
set -a && . ./.env && set +a
pnpm db:migrate                 # applique les migrations (vérifie les empreintes)
pnpm db:seed                    # devises ISO 4217 et pays ISO 3166-1
pnpm db:test                    # tests SQL, concurrence, intégrité (base *_test recréée)
pnpm db:verify                  # chaîne d'empreintes, soldes, balance générale, audit
```

## Structure

```
platform/
  db/                      @transfertplus/db — schéma, migrateur, tests
    migrations/            0001…0016, SQL versionné et immuable une fois appliqué
    seed/                  données de référence (générées, idempotentes)
    scripts/               générateur des données de référence
    src/                   CLI : migrate | status | verify | seed | test
    tests/                 fixtures, tests SQL, test de concurrence
  apps/api/                @transfertplus/api — API Express (TypeScript)
  packages/contracts/      contrat OpenAPI unique (types TS + client Dart)
  docker-compose.yml       environnement local
  .env.example             variables (aucune valeur réelle)
```

Voir [`db/README.md`](db/README.md) pour la conception du registre et
[`apps/api/README.md`](apps/api/README.md) pour l'architecture de l'API.
