# Déploiement et exploitation

Production sur un hôte (Docker Compose) derrière Caddy, base PostgreSQL gérée
(Supabase), images signées publiées par le workflow `platform-release`.

```
Internet ──TLS──▶ Caddy ──▶ web    (app.…)     ─┐
                      ├──▶ admin  (admin.…, réseau d'entreprise seul)
                      └──▶ api ×2 (api.…, sans /v1/admin) ◀─┘ (réseau interne)
                              │            worker ── prestataires (paiement, KYC, taux, listes)
                              ├── redis (réseau interne, sans accès Internet)
                              └── PostgreSQL géré (TLS verify-full)
```

## Images

`platform/Dockerfile` (une cible par composant : `api`, `migrate`, `web`,
`admin` ; le worker est l'image `api` avec la commande `dist/worker.js`).

- Exécution distroless (ni shell ni gestionnaire de paquets), utilisateur
  65532, système de fichiers en lecture seule, aucune capacité Linux.
- Aucune valeur de configuration ni aucun secret dans les images : tout est
  lu et validé au démarrage (une production mal configurée refuse de démarrer).
- Publication (`.github/workflows/platform-release.yml`, étiquette `vX.Y.Z`) :
  amd64 + arm64, SBOM, provenance SLSA, analyse Trivy bloquante, signature
  Sigstore — l'étiquette de version n'est posée qu'après analyse et signature.

Vérifier une image avant de la déployer :

```bash
cosign verify ghcr.io/amadou2-ops/transfertplus-api@sha256:… \
  --certificate-identity-regexp 'https://github.com/Amadou2-ops/NextJs/.github/workflows/platform-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

En production, référencer les images **par empreinte** (`TP_IMAGE_API=…@sha256:…`), jamais `latest`.

## Première installation

1. **Base (Supabase)** : projet dans la région la plus proche des clients,
   sauvegardes PITR activées. Télécharger le certificat du serveur dans
   `deploy/secrets/supabase-ca.crt`.
2. **Configuration** : copier `env/*.env.example` en `env/*.env` et compléter ;
   déposer le certificat de l'autorité d'horodatage dans `secrets/tsa-ca.pem`.
3. **Secrets** : `node deploy/scripts/generate-secrets.mjs production` (refuse
   d'écraser), puis conserver les fichiers dans le coffre de secrets et les
   retirer du poste de travail.
4. **Migrations** (rôle propriétaire du schéma) :
   `docker compose -f deploy/compose.production.yaml --env-file deploy/env/edge.env run --rm migrate`,
   puis `… run --rm migrate seed` et `… run --rm migrate verify`.
5. **Identifiant de l'API** (jamais le propriétaire) :
   `CREATE ROLE api_prod LOGIN PASSWORD '…' IN ROLE app_api;` (mot de passe
   long et aléatoire, reporté dans `env/api.env`).
6. **Démarrage** : `docker compose -f deploy/compose.production.yaml --env-file deploy/env/edge.env up -d`.
   Contrôle : `https://api.…/v1/health` → `{"status":"ok"}`.
7. **Binôme fondateur du back-office** (connexion propriétaire, deux fois —
   la double validation exige deux personnes dès la première invitation) :
   ```bash
   docker compose -f deploy/compose.production.yaml --env-file deploy/env/edge.env run --rm --no-deps \
     -e BOOTSTRAP_DATABASE_URL='postgres://postgres:…@db.….supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/run/secrets/supabase-ca.crt' \
     api dist/cli/bootstrapAdmin.js --email … --name "…" --ip-range 203.0.113.0/24
   ```
   Chaque lien d'enrôlement (affiché une seule fois) est remis en main propre.
8. **Webhooks** à déclarer chez les prestataires : `https://api.…/v1/webhooks/{stripe,flutterwave,thunes,onfido,smile-id}`.

## Mise à jour

1. Publier une version (`git tag vX.Y.Z && git push --tags`) ; vérifier les signatures.
2. `run --rm migrate` puis `run --rm migrate verify` (migrations additives,
   jamais modifiées : une version N-1 de l'API reste compatible avec le schéma N).
3. Mettre à jour les empreintes `TP_IMAGE_*` puis `up -d` (l'API tourne en
   deux répliques ; Caddy écarte une réplique défaillante).
4. Retour arrière : réappliquer les empreintes précédentes (le schéma n'est
   jamais rétrogradé).

## Rotation des secrets

| Secret | Procédure |
| --- | --- |
| Clés de signature des jetons | Publier la nouvelle clé publique dans `JWT_*_PUBLIC_JWKS` (deux clés), redéployer, puis basculer `JWT_*_SIGNING_KEY` ; retirer l'ancienne après la durée de vie des jetons |
| Trousseau des données personnelles | Ajouter une clé à `PII_KEYRING`, changer `activeKeyId` ; **ne jamais retirer** une clé tant que des données chiffrées avec elle existent |
| Cookies site / back-office | Nouvelle clé dans `SESSION_ENCRYPTION_KEY`, ancienne dans `SESSION_ENCRYPTION_KEY_PREVIOUS` le temps des sessions en cours |
| `BLIND_INDEX_KEY`, `OTP_HMAC_KEY` | Pas de rotation à chaud (recherche exacte et codes en cours) : procédure planifiée avec réindexation |
| Prestataires | Rotation côté prestataire, mise à jour de `env/api.env`, redémarrage de `api` et `worker` |

## Surveillance et incidents

- Santé : `GET /v1/health` (base et Redis) ; sonde intégrée à chaque conteneur.
- Registre : rapprochement horaire et ancrage RFC 3161 par le worker ;
  `GET /v1/admin/ledger/integrity` (back-office → Registre) doit rester « Sain ».
- Journal d'audit chaîné : back-office → Audit (rupture de chaîne = incident de sécurité).
- Compromission d'un compte client : suspension depuis le back-office (sessions révoquées immédiatement).
- Compromission d'un membre du personnel : désactivation (sessions, clés et invitations révoquées) ;
  vérifier ses demandes approuvées dans le journal d'audit.
- Suspicion sur le registre : gel du compte concerné (double validation), contre-passation si nécessaire.
