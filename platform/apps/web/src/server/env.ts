import "server-only";

import { z } from "zod";

/**
 * Configuration du serveur du site (BFF). Lue une seule fois, validée
 * strictement : un démarrage avec une configuration invalide échoue au lieu de
 * fonctionner en mode dégradé.
 */

const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "clé de 32 octets encodée en base64 attendue")
  .transform((value) => Buffer.from(value, "base64"));

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // API interne (réseau privé). Le navigateur ne l'appelle jamais directement.
  API_BASE_URL: z.url({ protocol: /^https?$/ }),
  // Origine publique du site (contrôle d'origine des mutations, cookies).
  APP_ORIGIN: z.url({ protocol: /^https?$/ }),
  // Clé de chiffrement des cookies de session (AES-256-GCM) et clé précédente
  // acceptée en lecture pendant une rotation.
  SESSION_ENCRYPTION_KEY: base64Key32,
  SESSION_ENCRYPTION_KEY_PREVIOUS: base64Key32.optional(),
  // Délai maximal d'un appel à l'API.
  API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  // Relais de confiance devant le site (répartiteur de charge) : l'adresse du
  // navigateur est lue à cette position depuis la droite de X-Forwarded-For.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
});

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface WebConfig {
  readonly production: boolean;
  readonly apiBaseUrl: string;
  readonly appOrigin: string;
  readonly sessionKeys: readonly Buffer[];
  readonly apiTimeoutMs: number;
  readonly trustedProxyHops: number;
}

export function parseWebConfig(source: Readonly<Record<string, string | undefined>>): WebConfig {
  const parsed = rawSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== "")));
  if (!parsed.success) {
    throw new Error(`Configuration du site invalide :\n${parsed.error.issues.map((issue) => `  - ${issue.path.join(".")} : ${issue.message}`).join("\n")}`);
  }
  const raw = parsed.data;
  const appOrigin = new URL(raw.APP_ORIGIN);
  if (appOrigin.origin !== raw.APP_ORIGIN.replace(/\/$/, "")) throw new Error("APP_ORIGIN doit être une origine (schéma, hôte, port), sans chemin");
  const production = raw.NODE_ENV === "production";
  // Seule exception : une exécution locale (localhost), qui ne peut pas être exposée publiquement.
  if (production && appOrigin.protocol !== "https:" && !LOCAL_HOSTS.has(appOrigin.hostname)) throw new Error("APP_ORIGIN doit être en https en production");
  if (raw.SESSION_ENCRYPTION_KEY_PREVIOUS?.equals(raw.SESSION_ENCRYPTION_KEY) === true) {
    throw new Error("SESSION_ENCRYPTION_KEY_PREVIOUS doit différer de la clé active");
  }
  return {
    production,
    apiBaseUrl: raw.API_BASE_URL.replace(/\/$/, ""),
    appOrigin: appOrigin.origin,
    sessionKeys: raw.SESSION_ENCRYPTION_KEY_PREVIOUS === undefined ? [raw.SESSION_ENCRYPTION_KEY] : [raw.SESSION_ENCRYPTION_KEY, raw.SESSION_ENCRYPTION_KEY_PREVIOUS],
    apiTimeoutMs: raw.API_TIMEOUT_MS,
    trustedProxyHops: raw.TRUSTED_PROXY_HOPS,
  };
}

let cached: WebConfig | undefined;

export function webConfig(): WebConfig {
  cached ??= parseWebConfig(process.env);
  return cached;
}
