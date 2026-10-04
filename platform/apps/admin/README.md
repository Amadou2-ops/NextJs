# @transfertplus/admin — back-office

Back-office TransfertPlus en Next.js 16 (App Router), conçu comme un **BFF** :
seul le serveur parle à l'API (`/v1/admin/*`), le navigateur ne détient qu'un
cookie chiffré.

## Accès du personnel

1. **Installation** : le binôme fondateur de super-administrateurs est créé par
   `pnpm --filter @transfertplus/api admin:bootstrap` (deux exécutions, connexion
   propriétaire du schéma). La double validation exige deux personnes dès la
   première invitation ; l'amorçage se ferme ensuite définitivement (migration 0024).
2. **Enrôlement** (`/enrolement#invitation=…`) : le jeton est lu dans le fragment
   d'URL (jamais envoyé avec la page ni journalisé), puis retiré de l'historique.
   Mot de passe de 14 caractères au moins et clé de sécurité **matérielle**
   (passkeys synchronisées refusées par l'API).
3. **Connexion** (`/connexion`) : mot de passe, puis assertion de la clé liée au
   défi, au compte et à l'adresse IP. Session d'inactivité courte, jetons
   d'accès de 10 minutes, renouvellement à usage unique (réutilisation = session
   révoquée).
4. **Réseau** : chaque requête est refusée hors des plages d'adresses autorisées
   du membre (adresse lue au rang `TRUSTED_PROXY_HOPS` de `X-Forwarded-For`).

## Écrans

| Écran | Permission | Actions |
| --- | --- | --- |
| Accueil | — | files de travail, habilitations du membre |
| Approbations | `approvals:decide` | approuver et exécuter / refuser ; le demandeur ne peut jamais statuer |
| Clients | `customers:read` | recherche exacte, fiche, données personnelles sur justification (`customers:read_pii`, tracé), suspension, dossier d'enquête |
| Transferts | `transfers:read` | mise en revue, libération, demande de remboursement (double validation) |
| Identité (KYC) | `kyc:read` | décision motivée, identité de la pièce sur demande tracée |
| Alertes / Dossiers LCB-FT | `aml:alerts:read` | prise en charge, escalade, clôture, dossiers, déclaration de soupçon (double validation) |
| Registre | `ledger:read` | balance, intégrité et ancrage, comptes, journaux ; gel, contre-passation et ajustement équilibré (double validation) |
| Personnel | `admins:manage` | invitation, rôles, réseaux, réactivation (double validation) ; suspension, désactivation, retrait de rôle (immédiats) |
| Audit | `audit:read` | journal chaîné filtrable, vérification de la chaîne de hachage |

## Sécurité

- Cookie `__Host-tpa_session` (JWE `dir` + `A256GCM`), HttpOnly, Secure,
  SameSite=Strict, expirant avec la session absolue ; clé distincte du site client.
- CSP sans aucun tiers ni style en ligne, nonce par requête (rendu toujours
  dynamique) ; `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`,
  `frame-ancestors 'none'`, contrôle de l'en-tête `Origin` sur toute mutation.
- Une valeur à usage unique (lien d'enrôlement) n'est affichée qu'une fois,
  jamais conservée.

## Commandes

```bash
pnpm --filter @transfertplus/admin dev        # http://localhost:3001
pnpm --filter @transfertplus/admin typecheck  # génère les types des routes puis tsc
pnpm --filter @transfertplus/admin lint
pnpm --filter @transfertplus/admin test
pnpm --filter @transfertplus/admin build      # sortie autonome (.next/standalone)
```

Configuration : voir [`.env.example`](.env.example).
