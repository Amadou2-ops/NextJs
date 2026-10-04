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

Réseau interne « monitoring » : api ×2 et worker (:9464) ◀── Prometheus ──▶ Alertmanager ──▶ Slack, PagerDuty, veille
                                journaux json-file ──▶ Alloy ──▶ Loki ◀── Grafana (127.0.0.1:3300, tunnel SSH)
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
8. **Surveillance** : déposer dans `deploy/secrets/` les destinations des
   alertes et le mot de passe initial de Grafana, lisibles par le seul
   utilisateur du conteneur qui les lit :
   ```bash
   printf '%s' 'https://hooks.slack.com/services/…' > secrets/alertmanager-slack-url
   printf '%s' '<clé d'intégration Events API v2>'   > secrets/alertmanager-pagerduty-key
   printf '%s' 'https://<service de veille>/ping/…' > secrets/alertmanager-deadman-url
   openssl rand -base64 32 | tr -d '\n'              > secrets/grafana-admin-password
   chown 65534:65534 secrets/alertmanager-* && chown 472:472 secrets/grafana-admin-password
   chmod 0400 secrets/alertmanager-* secrets/grafana-admin-password
   ```
   Le service de veille (Healthchecks.io, Better Stack…) attend un appel toutes
   les 5 min et alerte l'astreinte par un autre canal s'il cesse : il couvre
   la perte de Prometheus, d'Alertmanager ou de l'hôte entier.
9. **Prestataires** : ouvrir les comptes (sandbox puis live), déclarer les
   webhooks `https://api.…/v1/webhooks/{stripe,flutterwave,thunes,onfido,smile-id}`
   et lancer le contrôle automatique : voir [PRESTATAIRES.md](PRESTATAIRES.md).

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
| Prestataires | Rotation côté prestataire, mise à jour de `env/api.env`, redémarrage de `api` et `worker`, puis `checkProviders.js` ([PRESTATAIRES.md](PRESTATAIRES.md)) |

## Surveillance et alertes

Configuration dans [`monitoring/`](monitoring), vérifiée en CI (job
« Surveillance ») par `monitoring/tests/verifier.sh <binaires>` : syntaxe de
chaque fichier, tests unitaires des règles (`promtool test rules
alerts.test.yml`), requêtes du tableau, et chaîne des journaux de bout en bout.

**Métriques.** L'API et le worker exposent `/metrics` sur `METRICS_PORT`
(9464), réseau interne `monitoring` seulement : ni publié sur l'hôte, ni
routé par Caddy. Étiquettes à cardinalité bornée et sans donnée personnelle
(motif de route Express, jamais l'URL reçue).

| Source | Indicateurs |
| --- | --- |
| API (chaque réplique) | Durée des requêtes par méthode, motif de route et classe de statut ; processus Node.js (mémoire, boucle d'événements) |
| Worker, tâches | Exécutions par issue, durées, dernier succès et période de chaque tâche |
| Worker, base (à chaque collecte) | Dernier rapprochement du registre (sain ou non) et dernier ancrage RFC 3161 ; listes de sanctions courantes et leur âge ; dernier taux de change ; webhooks en attente ou en échec, refus par prestataire et motif ; outbox par statut et événements émis par type ; transferts non terminés et plus ancien par statut ; alertes LCB-FT ouvertes ; disjoncteurs de paiement |

Une collecte qui ne peut pas lire la base répond 503 : la cible est alors
« injoignable » plutôt que muette.

**Alertes** ([`alerts.yml`](monitoring/alerts.yml), seuils calés sur la
configuration par défaut de l'API) :

| Gravité | Alertes |
| --- | --- |
| `critical` → PagerDuty et Slack | Intégrité du registre rompue ou événement `ledger.integrity_breach` ; rapprochement absent depuis 3 périodes ; API ou worker injoignable ; webhook en attente depuis plus d'1 h ou abandonné ; outbox abandonnée ; remboursement bloqué depuis plus d'1 h ; listes de sanctions manquantes ou à moins de 4 h du refus ; taux de change périmés (devis refusés) ; disjoncteur ouvert depuis plus de 30 min ; plus de 10 % de 5xx ; erreur fatale journalisée |
| `warning` → Slack | Ancrage en retard ; tâche sans succès depuis 3 périodes ou en échecs répétés ; webhooks en échec ou en attente depuis plus de 15 min ; rafale de webhooks refusés (falsification ou secret désaligné) ; versement ou financement bloqué ; revue de conformité de plus de 24 h ; alerte LCB-FT bloquante non traitée depuis 4 h (équipe conformité) ; taux de change vieillissant ou refusé ; plus de 2 % de 5xx ; latence ; rafales d'erreurs journalisées ; Loki ou Alertmanager injoignable, journaux non collectés |

Une alerte critique masque sa variante d'avertissement. `VeilleAlertes` est
toujours active et part vers le service de veille.

**Journaux.** Chaque conteneur écrit en json-file, annoté de son service
Compose ; Alloy lit ces fichiers en lecture seule (sans socket Docker) et les
envoie à Loki : étiquettes `service`, `container`, `level` (journaux pino de
l'API et du worker), `stream`. Rétention de 30 jours ; les journaux de l'API
sont expurgés à la source (secrets, identité, coordonnées). Règles sur les
journaux : [`loki-rules/`](monitoring/loki-rules/fake/alerts.yml).

**Consultation.** Grafana écoute sur `127.0.0.1:3300` de l'hôte :
`ssh -L 3300:127.0.0.1:3300 <hôte>` puis <http://localhost:3300> (compte
`admin`, mot de passe de `secrets/grafana-admin-password`, à changer et à
compléter par un compte nominatif par personne). Tableau « TransfertPlus —
exploitation » ; journaux dans Explore > Loki, par exemple
`{service="worker", level="error"} | json` ; alertes en cours dans Alerting.

**Procédures par alerte.**

| Alerte | Premier geste |
| --- | --- |
| RegistreIntegriteRompue, RegistreAlerteIntegriteEmise | Back-office → Registre → Rapprochements : lire les anomalies. Ne rien contre-passer avant analyse ; geler les comptes concernés (double validation) |
| RegistreRapprochementEnRetard, TacheSansSucces | `docker compose logs worker` (« échec de la tâche ») ; base joignable ? verrou consultatif tenu par un worker figé ? |
| WebhookAbandonne, WebhooksFileEnRetard | Statut réel chez le prestataire ; rejouer ou rapprocher manuellement ; vérifier les secrets de signature ([PRESTATAIRES.md](PRESTATAIRES.md)) |
| WebhooksRefusesEnRafale | Adresses sources et motif (`integrations.webhook_rejections`) : rotation de secret non reportée, ou tentative de falsification à signaler |
| RemboursementBloque, VersementBloque | Fiche du transfert (back-office) puis statut chez le prestataire ; jamais de second envoi sans confirmation du premier |
| ListesSanctions*, TauxDeChange* | Journaux de la tâche `aml-lists` ou `fx-refresh` ; joignabilité de la source ; clés d'API |
| CibleInjoignable, WorkerAbsent, ApiAbsente | `docker compose ps`, journaux du service, `GET /v1/health` |

## Incidents

- Santé : `GET /v1/health` (base et Redis) ; sonde intégrée à chaque conteneur.
- Registre : rapprochement horaire et ancrage RFC 3161 par le worker, sous
  alerte (ci-dessus) ; `GET /v1/admin/ledger/integrity` (back-office → Registre) doit rester « Sain ».
- Journal d'audit chaîné : back-office → Audit (rupture de chaîne = incident de sécurité).
- Compromission d'un compte client : suspension depuis le back-office (sessions révoquées immédiatement).
- Compromission d'un membre du personnel : désactivation (sessions, clés et invitations révoquées) ;
  vérifier ses demandes approuvées dans le journal d'audit.
- Suspicion sur le registre : gel du compte concerné (double validation), contre-passation si nécessaire.
