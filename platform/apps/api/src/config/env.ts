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

const okpPrivateJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    kid: z.string().min(8).max(128),
    alg: z.literal("EdDSA"),
    use: z.literal("sig"),
  })
  .strict();

export type PrivateJwk = z.infer<typeof okpPrivateJwkSchema>;

const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
  token_uri: z.url({ protocol: /^https$/ }).default("https://oauth2.googleapis.com/token"),
});

export type GoogleServiceAccount = z.infer<typeof serviceAccountSchema>;

const csv = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item.length > 0));

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

  // Clé PRIVÉE active de signature des jetons clients (JWK Ed25519). Sa partie
  // publique doit figurer dans JWT_CUSTOMER_PUBLIC_JWKS (même kid, même x).
  JWT_CUSTOMER_SIGNING_KEY: jsonFromString(okpPrivateJwkSchema),
  // Clé HMAC des codes à usage unique (SMS).
  OTP_HMAC_KEY: base64Key32,

  SMS_PROVIDER: z.enum(["twilio", "log"]).default("twilio"),
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(32).optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-f]{32}$/).optional(),

  // Passkeys du site web client.
  WEBAUTHN_RP_ID: z.string().regex(/^[a-z0-9.-]+$/),
  WEBAUTHN_RP_NAME: z.string().min(1).max(64).default("TransfertPlus"),
  WEBAUTHN_ORIGINS: csv.pipe(z.array(originSchema).min(1).max(5)),

  // Attestation iOS (App Attest) : identifiants « TEAMID.bundle.id ».
  APPLE_APP_ATTEST_APP_IDS: csv.pipe(z.array(z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/)).max(5)).optional(),
  APPLE_APP_ATTEST_ALLOW_DEVELOPMENT: z.enum(["true", "false"]).default("false"),

  // Attestation Android (Play Integrity).
  ANDROID_PACKAGE_NAME: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).optional(),
  ANDROID_SIGNING_CERT_SHA256: csv.pipe(z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/)).max(5)).optional(),
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT: jsonFromString(serviceAccountSchema).optional(),

  // Contrôle des mots de passe compromis (Have I Been Pwned, k-anonymat).
  PASSWORD_BREACH_CHECK: z.enum(["enabled", "disabled"]).default("enabled"),

  // Ancrage externe du registre : autorité d'horodatage RFC 3161 et
  // certificats de confiance (PEM : racine et/ou certificat de la TSA).
  TSA_URL: z.url({ protocol: /^https?$/ }).optional(),
  TSA_TRUSTED_CERTS_PATH: z.string().min(1).optional(),
  TSA_ANCHOR_TARGET: z.string().regex(/^[a-z0-9_-]{2,50}$/).default("rfc3161-tsa"),

  // Taux de change : Open Exchange Rates (base USD) et Fixer via APILayer
  // (base USD, offre payante). Au moins un fournisseur en production ; les
  // deux recommandés (contrôle de divergence et bascule).
  OPEN_EXCHANGE_RATES_APP_ID: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  FIXER_API_KEY: z.string().regex(/^[A-Za-z0-9]{32}$/).optional(),
  FX_PRIMARY_PROVIDER: z.enum(["open_exchange_rates", "fixer"]).default("open_exchange_rates"),
  FX_MAX_RATE_AGE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  FX_MAX_DIVERGENCE_BPS: z.coerce.number().int().min(10).max(2000).default(200),
  FX_MAX_JUMP_BPS: z.coerce.number().int().min(50).max(5000).default(1000),
  FX_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  FX_QUOTE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),

  // Périodicité des tâches de fond (worker).
  RECONCILIATION_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  ANCHOR_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(1440).default(360),
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
  readonly auth: {
    readonly customerSigningKey: PrivateJwk;
    readonly otpHmacKey: Buffer;
    readonly sms:
      | { readonly provider: "log" }
      | {
          readonly provider: "twilio";
          readonly accountSid: string;
          readonly authToken: string;
          readonly messagingServiceSid: string;
        };
    readonly webauthn: { readonly rpId: string; readonly rpName: string; readonly origins: readonly string[] };
    readonly appAttest: { readonly appIds: readonly string[]; readonly allowDevelopment: boolean } | undefined;
    readonly playIntegrity:
      | {
          readonly packageName: string;
          readonly certificateDigests: readonly string[];
          readonly serviceAccount: GoogleServiceAccount;
        }
      | undefined;
    readonly passwordBreachCheck: boolean;
  };
  readonly fx: {
    readonly openExchangeRatesAppId: string | undefined;
    readonly fixerApiKey: string | undefined;
    readonly primaryProvider: "open_exchange_rates" | "fixer";
    readonly maxRateAgeMs: number;
    readonly maxDivergenceBps: number;
    readonly maxJumpBps: number;
    readonly refreshIntervalMs: number;
    readonly quoteTtlSeconds: number;
  };
  readonly ledger: {
    readonly timestampAuthority: { readonly url: string; readonly trustedCertsPem: string; readonly target: string } | undefined;
    readonly reconciliationIntervalMs: number;
    readonly anchorIntervalMs: number;
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

  if (strict) {
    if (raw.SMS_PROVIDER === "log") problems.push("SMS_PROVIDER=log (codes dans les journaux) interdit hors développement");
    if (raw.APPLE_APP_ATTEST_ALLOW_DEVELOPMENT === "true" && raw.APP_ENV === "production") {
      problems.push("APPLE_APP_ATTEST_ALLOW_DEVELOPMENT=true interdit en production");
    }
    if (raw.PASSWORD_BREACH_CHECK === "disabled" && raw.APP_ENV === "production") {
      problems.push("PASSWORD_BREACH_CHECK=disabled interdit en production");
    }
    for (const origin of raw.WEBAUTHN_ORIGINS) {
      if (origin.protocol !== "https:") problems.push(`origine WebAuthn non https interdite : ${origin.origin}`);
    }
  }

  if ((raw.TSA_URL === undefined) !== (raw.TSA_TRUSTED_CERTS_PATH === undefined)) {
    problems.push("TSA_URL et TSA_TRUSTED_CERTS_PATH vont de pair");
  }
  if (raw.APP_ENV === "production" && raw.TSA_URL === undefined) {
    problems.push("la production exige un ancrage externe du registre (TSA_URL, TSA_TRUSTED_CERTS_PATH)");
  }

  if (raw.APP_ENV === "production" && raw.OPEN_EXCHANGE_RATES_APP_ID === undefined && raw.FIXER_API_KEY === undefined) {
    problems.push("la production exige au moins un fournisseur de taux (OPEN_EXCHANGE_RATES_APP_ID ou FIXER_API_KEY)");
  }
  const primaryConfigured = raw.FX_PRIMARY_PROVIDER === "open_exchange_rates" ? raw.OPEN_EXCHANGE_RATES_APP_ID : raw.FIXER_API_KEY;
  if (primaryConfigured === undefined && (raw.OPEN_EXCHANGE_RATES_APP_ID !== undefined || raw.FIXER_API_KEY !== undefined)) {
    problems.push(`FX_PRIMARY_PROVIDER=${raw.FX_PRIMARY_PROVIDER} n'est pas configuré`);
  }

  const signingKey = raw.JWT_CUSTOMER_SIGNING_KEY;
  const publishedKey = raw.JWT_CUSTOMER_PUBLIC_JWKS.keys.find((key) => key.kid === signingKey.kid);
  if (publishedKey?.x !== signingKey.x) {
    problems.push(`la clé de signature ${signingKey.kid} doit être publiée (même kid, même x) dans JWT_CUSTOMER_PUBLIC_JWKS`);
  }

  if (raw.SMS_PROVIDER === "twilio" && (raw.TWILIO_ACCOUNT_SID === undefined || raw.TWILIO_AUTH_TOKEN === undefined || raw.TWILIO_MESSAGING_SERVICE_SID === undefined)) {
    problems.push("SMS_PROVIDER=twilio exige TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_MESSAGING_SERVICE_SID");
  }

  const androidValues = [raw.ANDROID_PACKAGE_NAME, raw.ANDROID_SIGNING_CERT_SHA256, raw.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT];
  const androidConfigured = androidValues.filter((value) => value !== undefined).length;
  if (androidConfigured !== 0 && androidConfigured !== androidValues.length) {
    problems.push("Play Integrity exige ensemble ANDROID_PACKAGE_NAME, ANDROID_SIGNING_CERT_SHA256 et GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT");
  }

  for (const rpOrigin of raw.WEBAUTHN_ORIGINS) {
    const host = rpOrigin.hostname;
    if (host !== raw.WEBAUTHN_RP_ID && !host.endsWith(`.${raw.WEBAUTHN_RP_ID}`)) {
      problems.push(`l'origine WebAuthn ${rpOrigin.origin} n'appartient pas au domaine ${raw.WEBAUTHN_RP_ID}`);
    }
  }

  const piiKeys = new Map(Object.entries(raw.PII_KEYRING.keys));
  const secretKeys: [string, Buffer][] = [
    ["BLIND_INDEX_KEY", raw.BLIND_INDEX_KEY],
    ["OTP_HMAC_KEY", raw.OTP_HMAC_KEY],
  ];
  if (raw.BLIND_INDEX_KEY.equals(raw.OTP_HMAC_KEY)) problems.push("OTP_HMAC_KEY doit être distincte de BLIND_INDEX_KEY");
  for (const [keyId, key] of piiKeys) {
    for (const [name, secret] of secretKeys) {
      if (key.equals(secret)) problems.push(`${name} ne doit pas être identique à la clé ${keyId}`);
    }
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
    auth: {
      customerSigningKey: signingKey,
      otpHmacKey: raw.OTP_HMAC_KEY,
      sms:
        raw.SMS_PROVIDER === "log" || raw.TWILIO_ACCOUNT_SID === undefined || raw.TWILIO_AUTH_TOKEN === undefined || raw.TWILIO_MESSAGING_SERVICE_SID === undefined
          ? { provider: "log" }
          : {
              provider: "twilio",
              accountSid: raw.TWILIO_ACCOUNT_SID,
              authToken: raw.TWILIO_AUTH_TOKEN,
              messagingServiceSid: raw.TWILIO_MESSAGING_SERVICE_SID,
            },
      webauthn: {
        rpId: raw.WEBAUTHN_RP_ID,
        rpName: raw.WEBAUTHN_RP_NAME,
        origins: raw.WEBAUTHN_ORIGINS.map((origin) => origin.origin),
      },
      appAttest:
        raw.APPLE_APP_ATTEST_APP_IDS === undefined || raw.APPLE_APP_ATTEST_APP_IDS.length === 0
          ? undefined
          : { appIds: raw.APPLE_APP_ATTEST_APP_IDS, allowDevelopment: raw.APPLE_APP_ATTEST_ALLOW_DEVELOPMENT === "true" },
      playIntegrity:
        raw.ANDROID_PACKAGE_NAME === undefined || raw.ANDROID_SIGNING_CERT_SHA256 === undefined || raw.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT === undefined
          ? undefined
          : {
              packageName: raw.ANDROID_PACKAGE_NAME,
              certificateDigests: raw.ANDROID_SIGNING_CERT_SHA256,
              serviceAccount: raw.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT,
            },
      passwordBreachCheck: raw.PASSWORD_BREACH_CHECK === "enabled",
    },
    fx: {
      openExchangeRatesAppId: raw.OPEN_EXCHANGE_RATES_APP_ID,
      fixerApiKey: raw.FIXER_API_KEY,
      primaryProvider: raw.FX_PRIMARY_PROVIDER,
      maxRateAgeMs: raw.FX_MAX_RATE_AGE_MINUTES * 60_000,
      maxDivergenceBps: raw.FX_MAX_DIVERGENCE_BPS,
      maxJumpBps: raw.FX_MAX_JUMP_BPS,
      refreshIntervalMs: raw.FX_REFRESH_INTERVAL_MINUTES * 60_000,
      quoteTtlSeconds: raw.FX_QUOTE_TTL_SECONDS,
    },
    ledger: {
      timestampAuthority:
        raw.TSA_URL === undefined || raw.TSA_TRUSTED_CERTS_PATH === undefined
          ? undefined
          : { url: raw.TSA_URL, trustedCertsPem: readFileSync(raw.TSA_TRUSTED_CERTS_PATH, "utf8"), target: raw.TSA_ANCHOR_TARGET },
      reconciliationIntervalMs: raw.RECONCILIATION_INTERVAL_MINUTES * 60_000,
      anchorIntervalMs: raw.ANCHOR_INTERVAL_MINUTES * 60_000,
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
