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
| 5 | Taux de change (Fixer, Open Exchange Rates), simulation et devis garantis | ✅ |
| 6 | KYC (Smile ID, Onfido), webhooks signés, niveaux accordés par la base | ✅ |
| 7 | Bénéficiaires, transferts, routage des paiements (Stripe, Flutterwave, Thunes), remboursements | ✅ |
| 8 | AML : listes OFAC / ONU / PEP versionnées, criblage, 11 règles, mise en revue garantie par la base | ✅ |
| 9 | API d'administration : personnel (mot de passe + clé WebAuthn), RBAC, double validation exécutée par l'approbateur, conformité, audit | ✅ |
| 10 | Tests de l'API : propriétés, parité avec PostgreSQL, matrice d'autorisation de toutes les routes, concurrence, intégrité en fin de suite, couverture bloquante | ✅ |
| 11 | Site client Next.js 16 : BFF détenant les jetons, session chiffrée, CSP à nonce, parcours d'envoi, paiement, KYC, sécurité | ✅ |
| 12 | Back-office Next.js 16 : connexion mot de passe + clé de sécurité, vues RBAC, double validation, registre, audit ; binôme fondateur (0024) | ✅ |
| 13 | Application mobile Flutter : clé matérielle (Secure Enclave / Keystore), App Attest / Play Integrity, requêtes signées, verrou biométrique, envoi, paiement, KYC | ✅ |
| 14 | Déploiement : images distroless signées (SBOM, provenance, analyse bloquante), pile Compose durcie derrière Caddy, secrets générés, procédure d'exploitation | ✅ |
| 15 | Mise en production : contrôle des comptes prestataires en lecture seule (identifiants, webhooks, environnement), publication mobile signée (Google Play, TestFlight), procédure d'ouverture sandbox puis live | ✅ |
| 16 | Tests de bout en bout : Playwright sur une pile réelle (base, Redis, API, worker, site, back-office) ; inscription, TOTP, passkeys, clé de sécurité du personnel, quatre yeux, transfert remboursé, bénéficiaire sanctionné retenu ; job CI | ✅ |
| 17 | Surveillance : métriques Prometheus de l'API et du worker (latences, tâches, registre, webhooks, outbox, transferts, conformité), 41 règles d'alerte testées (`promtool` et chaîne des journaux de bout en bout), Alertmanager (PagerDuty, Slack, veille externe), journaux centralisés (Alloy → Loki) avec alertes, tableau Grafana ; job CI | ✅ |
| 18 | Paramétrage depuis le back-office : marges de change, barèmes de frais, corridors, moyens d'encaissement, prestataires et pays, avec aperçu du prix client ; chaque modification en double validation, écrite par la base à l'identique de la demande approuvée et sans effet rétroactif (0026) | ✅ |
| 19 | Parcours de bout en bout de l'application mobile : l'app Flutter réelle contre la pile réelle (inscription avec attestation App Attest, portefeuille, envoi, reprise de session signée), autorité d'attestation de test acceptée en développement seulement ; ouverture d'un portefeuille depuis l'app (manquante), actualisation des écrans et menus déroulants corrigés ; job CI | ✅ |
| 20 | Consommateur de l'outbox (tâche `outbox-dispatch`) : journal d'exploitation par gravité, SMS aux clients pour l'issue de leurs transferts et de leur vérification d'identité (une seule fois, jamais pour un événement de conformité : garanti par la base, migration 0027), reprises croissantes et abandon signalé ; alertes d'anomalies de paiement et de SMS bloqués (règles testées) ; E2E : SMS de remboursement vérifié | ✅ |
| 21 | Mot de passe oublié (API, site, application mobile) : code SMS, application d'authentification exigée si activée, réponse identique pour un numéro inconnu, toutes les sessions fermées, avis de sécurité par SMS (migration 0028) ; E2E du site | ✅ |
| 22 | Clôture du compte par le client (site et application mobile, exigée par les magasins d'applications) : mot de passe ressaisi, session renforcée, signature d'appareil ; refusée tant qu'un solde est non nul ou qu'un transfert est en cours ; tous les accès révoqués, clôture définitive garantie par la base, données conservées pour la durée légale (migration 0029) ; E2E du site | ✅ |

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
    migrations/            0001…0026, SQL versionné et immuable une fois appliqué
    seed/                  données de référence (générées, idempotentes)
    scripts/               générateur des données de référence
    src/                   CLI : migrate | status | verify | seed | test
    tests/                 fixtures, tests SQL, test de concurrence
  apps/api/                @transfertplus/api — API Express (TypeScript)
  apps/web/                @transfertplus/web — site client Next.js 16 (BFF)
  apps/admin/              @transfertplus/admin — back-office Next.js 16 (BFF)
  apps/mobile/             application Flutter (iOS / Android)
  e2e/                     tests de bout en bout (Playwright, pile réelle)
  packages/contracts/      contrat OpenAPI unique (types TS + client Dart)
  Dockerfile               images de production (api, migrate, web, admin)
  deploy/                  pile de production, Caddy, secrets, procédure d'exploitation,
                           ouverture des comptes prestataires (PRESTATAIRES.md),
                           surveillance (monitoring/ : Prometheus, alertes, Loki, Grafana)
  docker-compose.yml       environnement local
  .env.example             variables (aucune valeur réelle)
```

Voir [`db/README.md`](db/README.md) pour la conception du registre et
[`apps/api/README.md`](apps/api/README.md) pour l'architecture de l'API,
[`apps/web/README.md`](apps/web/README.md) pour le site client,
[`apps/admin/README.md`](apps/admin/README.md) pour le back-office,
[`apps/mobile/README.md`](apps/mobile/README.md) pour l'application mobile,
[`deploy/README.md`](deploy/README.md) pour le déploiement et l'exploitation,
[`deploy/PRESTATAIRES.md`](deploy/PRESTATAIRES.md) pour l'ouverture des comptes prestataires,
[`e2e/README.md`](e2e/README.md) pour les tests de bout en bout.
