#!/usr/bin/env node
/**
 * Génère les secrets cryptographiques d'un environnement TransfertPlus :
 *
 *   node deploy/scripts/generate-secrets.mjs production
 *
 * Écrit deploy/env/{api,web,admin}.secrets.env (droits 0600) et REFUSE
 * d'écraser un fichier existant : une clé de chiffrement des données
 * personnelles régénérée par erreur rendrait les données illisibles.
 *
 *   - jetons clients et personnel : paires Ed25519 distinctes (JWK privée,
 *     JWKS publique) ;
 *   - données personnelles : trousseau AES-256 (rotation : ajouter une clé,
 *     changer activeKeyId, conserver les anciennes) ;
 *   - index aveugles et OTP : clés HMAC de 256 bits ;
 *   - cookies du site et du back-office : deux clés AES-256 distinctes.
 *
 * À stocker ensuite dans le coffre de secrets de l'hébergeur ; les fichiers
 * locaux ne doivent pas rester sur un poste de travail.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const environment = process.argv[2];
if (!/^[a-z][a-z0-9-]{1,20}$/.test(environment ?? "")) {
  process.stderr.write("Usage : node deploy/scripts/generate-secrets.mjs <environnement> (ex. production)\n");
  process.exit(64);
}

const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const envDir = join(dirname(fileURLToPath(import.meta.url)), "..", "env");

function signingKey(audience) {
  const kid = `${environment}-${audience}-${stamp}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const common = { kid, alg: "EdDSA", use: "sig" };
  return {
    privateJwk: JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...common }),
    publicJwks: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), ...common }] }),
  };
}

const key32 = () => randomBytes(32).toString("base64");
const customer = signingKey("customer");
const admin = signingKey("admin");
const piiKeyId = `pii-${environment}-${stamp}`;

const files = {
  "api.secrets.env": {
    JWT_CUSTOMER_SIGNING_KEY: customer.privateJwk,
    JWT_CUSTOMER_PUBLIC_JWKS: customer.publicJwks,
    JWT_ADMIN_SIGNING_KEY: admin.privateJwk,
    JWT_ADMIN_PUBLIC_JWKS: admin.publicJwks,
    PII_KEYRING: JSON.stringify({ activeKeyId: piiKeyId, keys: { [piiKeyId]: key32() } }),
    BLIND_INDEX_KEY: key32(),
    OTP_HMAC_KEY: key32(),
  },
  "web.secrets.env": { SESSION_ENCRYPTION_KEY: key32() },
  "admin.secrets.env": { SESSION_ENCRYPTION_KEY: key32() },
};

for (const name of Object.keys(files)) {
  if (existsSync(join(envDir, name))) {
    process.stderr.write(`Refus : ${join(envDir, name)} existe déjà (aucun secret écrasé).\n`);
    process.exit(73);
  }
}
for (const [name, values] of Object.entries(files)) {
  const body = Object.entries(values)
    // Format env_file de Docker Compose : valeur entre apostrophes, sans interpolation.
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n");
  writeFileSync(join(envDir, name), `# Généré le ${new Date().toISOString()} pour « ${environment} ». NE PAS VERSIONNER.\n${body}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`écrit : deploy/env/${name}\n`);
}
