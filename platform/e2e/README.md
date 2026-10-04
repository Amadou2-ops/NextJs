# Tests de bout en bout (`@transfertplus/e2e`)

Playwright pilote le **site client** et le **back-office** en build de
production, et `flutter test` l'**application mobile** réelle, sur une pile
réelle démarrée par `scripts/stack.ts` :

- base PostgreSQL neuve `transfertplus_e2e` (migrations et données de référence) ;
- Redis ;
- API et worker ;
- site client et back-office.

## Lancer

```bash
pnpm --filter @transfertplus/web build
pnpm --filter @transfertplus/admin build
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432 \
E2E_REDIS_URL=redis://127.0.0.1:6379/9 \
  pnpm --filter @transfertplus/e2e e2e              # arguments transmis à `playwright test`
```

| Variable | Rôle |
| --- | --- |
| `E2E_POSTGRES_URL` | Serveur PostgreSQL. Connexion propriétaire, sans nom de base : la base `transfertplus_e2e` y est recréée à chaque exécution |
| `E2E_REDIS_URL` | Base Redis **dédiée**, vidée à chaque exécution (limiteurs de débit) |
| `E2E_CHROMIUM_EXECUTABLE` | Facultatif : Chromium déjà installé, à la place de `playwright install chromium` |
| `E2E_SUITE` | `web` (défaut : Playwright) ou `mobile` (application Flutter ; site et back-office non démarrés) |
| `E2E_FLUTTER` | Facultatif : binaire Flutter (défaut : `flutter`) |

Parcours mobile :

```bash
E2E_SUITE=mobile E2E_POSTGRES_URL=… E2E_REDIS_URL=… pnpm --filter @transfertplus/e2e e2e --timeout=5m   # arguments transmis à `flutter test`
```

Ports utilisés :
- 8080 : API ;
- 3000 : site client, sur `localhost`, comme exigé par WebAuthn ;
- 3001 : back-office ;
- 8099 : serveur des listes de criblage ;
- 8098 : composant sécurisé et services de contrôle du parcours mobile.

Les journaux de chaque processus sont dans `.runtime/*.log`. En CI, le rapport, les traces et les journaux sont archivés en cas d'échec.

## Parcours

| Fichier | Couvre |
| --- | --- |
| `01-client.spec.ts` | Estimation publique au taux du jour ; CSP à nonce ; inscription par code SMS ; cookie de session JWE `__Host-`, HttpOnly, Secure, Strict ; activation TOTP ; passkey ; déconnexion ; mot de passe erroné ; connexion avec second facteur TOTP ; connexion sans mot de passe par passkey ; refus d'une mutation d'une autre origine |
| `02-back-office.spec.ts` | Enrôlement du binôme fondateur (mot de passe et clé de sécurité matérielle) ; lien d'invitation à usage unique ; connexion par clé ; règle des quatre yeux sur une invitation ; enrôlement d'un agent du support et habilitations limitées ; chaîne d'audit intacte ; refus d'une autre origine ; déconnexion |
| `03-transfert.spec.ts` | Client vérifié ; portefeuille crédité par un ajustement comptable validé à deux ; envoi de 100 EUR vers le Sénégal (devis garanti, bénéficiaire, code TOTP) ; remboursement automatique faute de route de paiement sortant ; registre équilibré et rapprochement sain ; bénéficiaire sanctionné retenu avec une alerte bloquante côté conformité |
| `04-parametrage.spec.ts` | Remplacement d'un barème de frais demandé par un membre du binôme fondateur, approuvé par le second : sans effet avant l'approbation, signalé sur le barème visé, appliqué ensuite à l'aperçu du prix client, ancien barème terminé ; pays interdit jamais ouvert |
| `apps/mobile/e2e_test/parcours_mobile_test.dart` | Application mobile réelle (écrans, client API, signature des requêtes, session) : inscription par code SMS avec enregistrement de l'appareil par attestation App Attest ; identité vérifiée ; portefeuille EUR ouvert par une requête signée ; envoi de 100 EUR vers le Sénégal confirmé par la biométrie, remboursé faute de route ; relance de l'application, session reprise par un renouvellement signé, rien d'affiché avant le déverrouillage |

Chaque parcours vérifie aussi qu'aucune erreur JavaScript ni violation de la CSP ne s'est produite.

## Ce qui est réel, ce qui est simulé

Tout passe par le vrai code, sauf ce que des services externes fourniraient :

| Élément | Traitement |
| --- | --- |
| SMS | `SMS_PROVIDER=log` de l'API de développement : le code est lu dans son journal |
| Décision KYC du prestataire | Enregistrée en base comme le ferait le service KYC. L'identité déclarée est chiffrée par le chiffreur de champs de l'API ; le niveau est accordé par la base |
| Ouverture du portefeuille | Réservée à l'application mobile (requête signée par l'appareil) : même fonction de la base, au nom du client |
| Listes de sanctions | Formats officiels OFAC et ONU, entrées fictives (`fixtures/listes`), importées par le vrai worker |
| Taux et corridor | Paramétrage initial (corridor France → Sénégal, marge, barème) et taux enregistrés comme par l'exploitant et la tâche `fx-refresh` ; le barème est ensuite remplacé depuis le back-office (`04-`) |
| Prestataires de paiement | Non configurés : un transfert financé est remboursé, comme en production sans route |
| Clés de sécurité, passkeys | Authentificateurs virtuels de Chromium (CTAP2) |
| Composant sécurisé de l'iPhone (mobile) | Service local (`support/secureElement.ts`) : clé P-256, signatures ECDSA DER, attestation au format App Attest exact signée par une autorité racine de test. L'API ne l'accepte que via `APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH`, refusé hors développement et tests ; tout le reste (vérification, enregistrement, signature des requêtes, compteur) est le code de production |
| Stockage sécurisé et biométrie (mobile) | Mémoire et authentification acceptée |
| Approvisionnement du portefeuille (mobile) | Écriture d'ajustement de l'exploitant, en base |

## Écrire un parcours

- Fichiers numérotés, exécutés dans l'ordre par un seul worker : ils partagent la base, et le binôme fondateur est enrôlé par `02-`.
- Personnel :
  - fixture `staff` de `support/staff.ts`. Chaque membre garde son navigateur et sa clé pendant toute l'exécution, comme une vraie clé matérielle ;
  - `signIn` se reconnecte seulement si la session a expiré.
- Codes TOTP : `freshTotp` attend la période suivante si besoin, car l'API refuse le rejeu d'un code.
- Sélecteurs : rôles, libellés et textes visibles, pas de classes CSS sauf pour un badge de statut. Les montants s'écrivent avec des espaces insécables : utiliser `\s` dans les expressions régulières.
