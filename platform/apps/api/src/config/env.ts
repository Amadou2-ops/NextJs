import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * Configuration de l'API, validée au démarrage. Toute valeur absente, mal
 * formée ou dangereuse pour l'environnement visé empêche le démarrage : un
 * service financier ne doit jamais tourner avec une configuration dégradée.
 *
 * Les secrets (DATABASE_URL, clés de chiffrement, clés de signature) sont
 * injectés par le gestionnaire de secrets de la plateforme d'hébergement ;
 * ils ne figurent jamais dans un fichier versionné.
 */

const appEnvironments = ["development", "test", "staging", "production"] as const;
export type AppEnvironment = (typeof appEnvironments)[number];

const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "clé attendue : 32 octets encodés en base64")
  .transform((value) => Buffer.from(value, "base64"));

const keyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "identifiant de clé invalide");

const keyringSchema = z
  .object({
    activeKeyId: keyIdSchema,
    keys: z.record(keyIdSchema, base64Key32),
  })
  .refine((ring) => Object.hasOwn(ring.keys, ring.activeKeyId), {
    message: "activeKeyId doit désigner une clé présente dans keys",
  });

const okpPublicJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    kid: z.string().min(8).max(128),
    alg: z.literal("EdDSA"),
    use: z.literal("sig"),
  })
  .strict();

const publicJwksSchema = z
  .object({ keys: z.array(okpPublicJwkSchema).min(1).max(10) })
  .strict()
  .refine((jwks) => new Set(jwks.keys.map((key) => key.kid)).size === jwks.keys.length, {
    message: "identifiants de clé (kid) dupliqués",
  });

export type PublicJwk = z.infer<typeof okpPublicJwkSchema>;
export type PublicJwks = z.infer<typeof publicJwksSchema>;

function jsonFromString<T extends z.ZodType>(schema: T): z.ZodPipe<z.ZodString, z.ZodTransform<z.infer<T>, string>> {
  return z.string().transform((raw, context): z.infer<T> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      context.addIssue({ code: "custom", message: "JSON invalide" });
      return z.NEVER;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ code: "custom", message: `${issue.path.join(".")}: ${issue.message}` });
      }
      return z.NEVER;
    }
    return result.data;
  });
}

const originSchema = z.string().transform((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: `origine invalide : ${value}` });
    return z.NEVER;
  }
  if (url.origin !== value) {
    context.addIssue({ code: "custom", message: `origine non canonique (attendu ${url.origin}) : ${value}` });
    return z.NEVER;
  }
  return url;
});

const rawEnvironmentSchema = z.object({
  APP_ENV: z.enum(appEnvironments),
  APP_VERSION: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/).default("0.0.0-dev"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // Nombre de proxys de confiance devant l'API (répartiteur de charge).
  // Détermine l'adresse IP client retenue pour la limitation de débit.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("verify-full"),
  DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))
    .pipe(z.array(originSchema).min(1).max(20)),

  JWT_ISSUER: z.url({ protocol: /^https?$/ }),
  // Clés publiques de vérification des jetons clients (aud = mobile | web).
  JWT_CUSTOMER_PUBLIC_JWKS: jsonFromString(publicJwksSchema),
  // Clés publiques de vérification des jetons du personnel (aud = admin).
  // Jeu de clés distinct : la compromission de l'un n'affecte pas l'autre.
  JWT_ADMIN_PUBLIC_JWKS: jsonFromString(publicJwksSchema),

  // Clés de chiffrement des données personnelles (KEK), avec rotation.
  PII_KEYRING: jsonFromString(keyringSchema),
  // Clé HMAC des index aveugles. Distincte des clés de chiffrement ; ne
  // tourne jamais sans réindexation complète.
  BLIND_INDEX_KEY: base64Key32,
});

type RawEnvironment = z.infer<typeof rawEnvironmentSchema>;

export interface DatabaseSsl {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string;
}

export interface AppConfig {
  readonly appEnv: AppEnvironment;
  readonly appVersion: string;
  readonly isProduction: boolean;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly trustProxyHops: number;
  };
  readonly logLevel: RawEnvironment["LOG_LEVEL"];
  readonly database: {
    readonly url: string;
    readonly ssl: DatabaseSsl | false;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };
  readonly redisUrl: string;
  readonly corsAllowedOrigins: ReadonlySet<string>;
  readonly jwt: {
    readonly issuer: string;
    readonly customerJwks: PublicJwks;
    readonly adminJwks: PublicJwks;
  };
  readonly crypto: {
    readonly piiKeyring: { readonly activeKeyId: string; readonly keys: ReadonlyMap<string, Buffer> };
    readonly blindIndexKey: Buffer;
  };
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawEnvironmentSchema.safeParse(stripEmpty(env));
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(racine)"} : ${issue.message}`);
    throw new ConfigurationError(`Configuration invalide :\n${details.join("\n")}`);
  }
  const raw = parsed.data;
  const strict = raw.APP_ENV === "staging" || raw.APP_ENV === "production";
  const problems: string[] = [];

  if (strict) {
    if (raw.DATABASE_SSL_MODE === "disable") problems.push("DATABASE_SSL_MODE=disable interdit hors développement");
    if (raw.APP_ENV === "production" && raw.DATABASE_SSL_MODE !== "verify-full") {
      problems.push("la production exige DATABASE_SSL_MODE=verify-full");
    }
    if (!raw.REDIS_URL.startsWith("rediss://")) problems.push("REDIS_URL doit utiliser TLS (rediss://) hors développement");
    if (!raw.JWT_ISSUER.startsWith("https://")) problems.push("JWT_ISSUER doit être en https hors développement");
    for (const origin of raw.CORS_ALLOWED_ORIGINS) {
      if (origin.protocol !== "https:") problems.push(`origine CORS non https interdite : ${origin.origin}`);
      if (LOCAL_HOSTNAMES.has(origin.hostname)) problems.push(`origine CORS locale interdite : ${origin.origin}`);
    }
    if (raw.LOG_LEVEL === "trace" || raw.LOG_LEVEL === "debug") {
      problems.push(`LOG_LEVEL=${raw.LOG_LEVEL} interdit hors développement`);
    }
  }

  const customerKids = new Set(raw.JWT_CUSTOMER_PUBLIC_JWKS.keys.map((key) => key.kid));
  for (const key of raw.JWT_ADMIN_PUBLIC_JWKS.keys) {
    if (customerKids.has(key.kid)) problems.push(`la clé ${key.kid} est partagée entre clients et personnel`);
  }

  const piiKeys = new Map(Object.entries(raw.PII_KEYRING.keys));
  for (const [keyId, key] of piiKeys) {
    if (key.equals(raw.BLIND_INDEX_KEY)) problems.push(`BLIND_INDEX_KEY ne doit pas être identique à la clé ${keyId}`);
  }

  if (problems.length > 0) {
    throw new ConfigurationError(`Configuration refusée pour ${raw.APP_ENV} :\n  - ${problems.join("\n  - ")}`);
  }

  return {
    appEnv: raw.APP_ENV,
    appVersion: raw.APP_VERSION,
    isProduction: raw.APP_ENV === "production",
    http: { host: raw.HOST, port: raw.PORT, trustProxyHops: raw.TRUST_PROXY_HOPS },
    logLevel: raw.LOG_LEVEL,
    database: {
      url: raw.DATABASE_URL,
      ssl: buildDatabaseSsl(raw.DATABASE_SSL_MODE, raw.DATABASE_SSL_CA_PATH),
      poolMax: raw.DATABASE_POOL_MAX,
      statementTimeoutMs: raw.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    redisUrl: raw.REDIS_URL,
    corsAllowedOrigins: new Set(raw.CORS_ALLOWED_ORIGINS.map((origin) => origin.origin)),
    jwt: {
      issuer: raw.JWT_ISSUER,
      customerJwks: raw.JWT_CUSTOMER_PUBLIC_JWKS,
      adminJwks: raw.JWT_ADMIN_PUBLIC_JWKS,
    },
    crypto: {
      piiKeyring: { activeKeyId: raw.PII_KEYRING.activeKeyId, keys: piiKeys },
      blindIndexKey: raw.BLIND_INDEX_KEY,
    },
  };
}

function buildDatabaseSsl(mode: RawEnvironment["DATABASE_SSL_MODE"], caPath: string | undefined): DatabaseSsl | false {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return caPath === undefined
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ca: readFileSync(caPath, "utf8") };
    case "verify-full":
      if (caPath === undefined) throw new ConfigurationError("DATABASE_SSL_MODE=verify-full exige DATABASE_SSL_CA_PATH");
      return { rejectUnauthorized: true, ca: readFileSync(caPath, "utf8") };
  }
}

function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") result[key] = value;
  }
  return result;
}
