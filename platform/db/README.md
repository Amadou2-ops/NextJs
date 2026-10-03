# @transfertplus/db — base de données et registre comptable

## Schémas

| Schéma | Rôle |
|---|---|
| `ref` | Devises ISO 4217 (exposant figé), pays ISO 3166-1 (fermés par défaut) |
| `identity` | Clients (PII chiffrées + index aveugles), appareils, sessions, jetons de renouvellement, OTP |
| `kyc` | Vérifications Smile ID / Onfido, documents, historique de revue, plafonds par niveau |
| `fx` | Taux (ajout seul), marges, devis vérifiés arithmétiquement |
| `ledger` | Registre en partie double, chaîné par SHA-256 |
| `transfers` | Bénéficiaires, barèmes, transferts, machine à états, historique |
| `payments` | Prestataires, corridors, moyens d'encaissement, disjoncteurs, tentatives |
| `integrations` | Webhooks authentifiés, rejets, outbox, idempotence HTTP |
| `aml` | Règles, profils de risque, criblage, alertes, dossiers |
| `backoffice` | Personnel, RBAC, sessions admin, double validation |
| `audit` | Journal d'audit chaîné, ajout seul |

## Garanties du registre

1. **Point d'entrée unique.** Un solde ne change que par `ledger.post_journal()`
   ou `ledger.reverse_journal()`. Le rôle applicatif `app_api` n'a aucun droit
   `INSERT/UPDATE/DELETE` sur les tables du registre, et une garde interne
   bloque aussi les écritures directes du propriétaire des tables.
2. **Partie double.** Chaque journal compte de 2 à 100 lignes, équilibrées par
   devise. C'est vérifié avant l'écriture, puis à nouveau au `COMMIT` par des
   triggers de contrainte différés.
3. **Montants entiers.** Tous les montants sont des `bigint` en unités
   mineures. Les montants décimaux, négatifs ou transmis en texte sont refusés.
4. **Pas de solde négatif client.** `CHECK (allow_negative OR balance >= 0)`
   est une contrainte physique. Les comptes clients ne peuvent jamais
   autoriser de découvert : c'est imposé par une contrainte CHECK et un
   trigger qui empêche ensuite de modifier ce réglage.
5. **Concurrence.** Les soldes sont verrouillés par `SELECT … FOR UPDATE`,
   toujours dans l'ordre des identifiants de compte, puis la tête de chaîne
   est verrouillée. Résultats testés : aucune double dépense, aucun
   interblocage, et l'idempotence tient sous charge.
6. **Immuabilité.** `UPDATE`, `DELETE` et `TRUNCATE` sont interdits sur les
   journaux et les écritures. Une correction passe par une contre-passation,
   qui est unique et elle-même non contre-passable.
7. **Détection d'altération.** Chaque journal porte l'empreinte du précédent
   (`prev_hash`) et la sienne (`hash`), calculée sur tout son contenu, soldes
   résultants compris. `ledger.verify_chain()`, `ledger.verify_balances()` et
   `ledger.trial_balance` détectent toute modification, même faite par un
   superutilisateur qui aurait désactivé les triggers : un test le démontre.
   Pour se prémunir d'un administrateur qui réécrirait toute la chaîne, il
   faut publier l'empreinte de tête hors de la base (`ledger.chain_anchors`,
   job en phase 4).

## Codes d'erreur (SQLSTATE)

| Code | Signification |
|---|---|
| LG001 | Provision insuffisante |
| LG002 | Journal déséquilibré |
| LG003 | Compte gelé ou clôturé |
| LG004 | Devise de l'écriture ≠ devise du compte |
| LG005 | Clé d'idempotence réutilisée avec un contenu différent |
| LG006 | Enregistrement immuable / écriture directe interdite |
| LG007 | Données invalides |
| LG008 | Contre-passation invalide |
| LG009 | Chaîne d'empreintes incohérente |
| TR001 | Transition de statut interdite |
| TR002 | Devis expiré, consommé ou non respecté |
| PY001 | Transition de tentative de paiement interdite |
| BO001 | Règle des quatre yeux violée |

## Rôles PostgreSQL

`app_api` (API et workers), `app_readonly` (lecture sans aucun secret
d'authentification), `app_auditor` (registre, audit et fonctions de
vérification). Ce sont des rôles de groupe `NOLOGIN` : chaque environnement
crée ses propres identifiants de connexion et les rattache à ces groupes.
Sur Supabase, `anon`, `authenticated` et `service_role` n'ont aucun accès à
ces schémas, et la RLS est activée sur toutes les tables.

## Commandes

```bash
pnpm migrate   # applique les migrations en attente (verrou consultatif, empreintes)
pnpm status    # état des migrations, détecte toute migration modifiée après application
pnpm seed      # données de référence (idempotent)
pnpm verify    # contrôle d'intégrité complet (code de sortie 2 en cas d'anomalie)
pnpm test      # recrée la base *_test, migre, teste (SQL + concurrence + intégrité)
pnpm generate:reference  # régénère seed/0001 et seed/0002
```

Règle d'or : **une migration appliquée n'est jamais modifiée.** Toute
évolution passe par un nouveau fichier `NNNN_nom.sql`.
