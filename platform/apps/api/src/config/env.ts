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
  // Métriques Prometheus (GET /metrics) sur un port interne distinct, jamais
  // routé publiquement. Absent : pas de serveur de métriques.
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  METRICS_HOST: z.string().default("127.0.0.1"),
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

  // Personnel : clé PRIVÉE de signature des jetons aud=admin (publiée dans
  // JWT_ADMIN_PUBLIC_JWKS), clés WebAuthn du dashboard, sessions courtes.
  JWT_ADMIN_SIGNING_KEY: jsonFromString(okpPrivateJwkSchema),
  ADMIN_WEBAUTHN_RP_ID: z.string().regex(/^[a-z0-9.-]+$/),
  ADMIN_WEBAUTHN_RP_NAME: z.string().min(1).max(64).default("TransfertPlus Back-office"),
  ADMIN_WEBAUTHN_ORIGINS: csv.pipe(z.array(originSchema).min(1).max(3)),
  // Modèles de clés matérielles acceptés (AAGUID), vide = tout authentificateur lié à l'appareil.
  ADMIN_WEBAUTHN_ALLOWED_AAGUIDS: csv.pipe(z.array(z.uuid()).max(50)).optional(),
  ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(30).default(15),
  ADMIN_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(12).default(8),
  ADMIN_INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(48),
  // Page d'enrôlement du dashboard (le jeton d'invitation y est ajouté en fragment).
  ADMIN_ENROLLMENT_URL: z.url({ protocol: /^https?$/ }),

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
  // Autorité racine de TEST remplaçant la racine Apple (tests de bout en bout
  // de l'application mobile) : refusée hors développement et tests.
  APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH: z.string().min(1).optional(),

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

  // KYC — Onfido (Studio : un workflow par type de contrôle) et Smile ID.
  // Au moins un prestataire en production.
  ONFIDO_API_TOKEN: z.string().regex(/^api_(live|sandbox)[A-Za-z0-9_.-]{16,}$/).optional(),
  ONFIDO_REGION: z.enum(["eu", "us", "ca"]).default("eu"),
  ONFIDO_WEBHOOK_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{16,}$/).optional(),
  ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: z.uuid().optional(),
  ONFIDO_WORKFLOW_PROOF_OF_ADDRESS: z.uuid().optional(),
  SMILE_ID_PARTNER_ID: z.string().regex(/^[0-9]{1,12}$/).optional(),
  SMILE_ID_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{16,}$/).optional(),
  SMILE_ID_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  SMILE_ID_CALLBACK_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Fenêtre d'acceptation de l'horodatage signé des rappels Smile ID.
  SMILE_ID_CALLBACK_TOLERANCE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  // Validité d'une vérification approuvée avant nouvelle vérification.
  KYC_VERIFICATION_VALIDITY_DAYS: z.coerce.number().int().min(30).max(1825).default(730),
  // Délai laissé au client pour terminer la capture dans le SDK.
  KYC_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // Tentatives par niveau sur 30 jours glissants (anti-fraude, coût prestataire).
  KYC_MAX_ATTEMPTS_PER_30_DAYS: z.coerce.number().int().min(1).max(20).default(3),
  KYC_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),

  // Paiements — Stripe (encaissement carte / Apple Pay / Google Pay),
  // Flutterwave (encaissement mobile money / virement, paiements sortants
  // Afrique) et Thunes (paiements sortants internationaux).
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(live|test)_[A-Za-z0-9]{16,}$/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/).optional(),
  STRIPE_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/).default("2026-09-30.endive"),
  FLUTTERWAVE_SECRET_KEY: z.string().regex(/^FLWSECK(_TEST)?-[A-Za-z0-9]{16,}-X$/).optional(),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(16).max(200).optional(),
  FLUTTERWAVE_REDIRECT_URL: z.url({ protocol: /^https?$/ }).optional(),
  THUNES_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  THUNES_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,}$/).optional(),
  THUNES_API_SECRET: z.string().min(16).optional(),
  THUNES_CALLBACK_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Devise du compte de préfinancement Thunes (devise source des cotations).
  THUNES_SETTLEMENT_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  // Adresses d'émission des rappels Thunes (liste blanche facultative).
  THUNES_CALLBACK_ALLOWED_IPS: csv.pipe(z.array(z.union([z.ipv4(), z.ipv6()])).max(20)).optional(),
  // Délai de paiement d'un transfert avant annulation automatique.
  PAYMENTS_FUNDING_TTL_MINUTES: z.coerce.number().int().min(10).max(1440).default(60),
  // Nombre maximal de routes de paiement sortant essayées avant remboursement.
  PAYOUT_MAX_ROUTES: z.coerce.number().int().min(1).max(5).default(3),
  // Disjoncteur des prestataires.
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(2).max(50).default(5),
  CIRCUIT_OPEN_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  PAYMENTS_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

  // Lutte anti-blanchiment : listes de criblage et seuil de correspondance.
  AML_OFAC_SDN_URL: z.url({ protocol: /^https?$/ }).default("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV"),
  AML_OFAC_ALT_URL: z.url({ protocol: /^https?$/ }).default("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV"),
  AML_UN_LIST_URL: z.url({ protocol: /^https?$/ }).default("https://scsanctions.un.org/resources/xml/en/consolidated.xml"),
  // Liste PPE OpenSanctions (licence commerciale requise) : activée si l'URL est fournie.
  AML_OPENSANCTIONS_PEP_URL: z.url({ protocol: /^https?$/ }).optional(),
  AML_OPENSANCTIONS_API_KEY: z.string().min(16).optional(),
  AML_MATCH_THRESHOLD: z.coerce.number().min(0.75).max(0.99).default(0.88),
  AML_LISTS_MAX_AGE_HOURS: z.coerce.number().int().min(6).max(168).default(48),
  AML_LISTS_REFRESH_HOURS: z.coerce.number().int().min(1).max(48).default(6),

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
  readonly metrics: { readonly host: string; readonly port: number } | undefined;
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
    readonly appAttest: { readonly appIds: readonly string[]; readonly allowDevelopment: boolean; readonly testRootCertificatePem?: string } | undefined;
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
  readonly kyc: {
    readonly onfido:
      | {
          readonly apiToken: string;
          readonly baseUrl: string;
          readonly webhookToken: string;
          readonly workflows: { readonly document_verification: string | undefined; readonly proof_of_address: string | undefined };
        }
      | undefined;
    readonly smileId:
      | {
          readonly partnerId: string;
          readonly apiKey: string;
          readonly environment: "sandbox" | "production";
          readonly baseUrl: string;
          readonly callbackUrl: string;
          readonly callbackToleranceSeconds: number;
        }
      | undefined;
    readonly verificationValidityDays: number;
    readonly sessionTtlHours: number;
    readonly maxAttemptsPer30Days: number;
    readonly syncIntervalMs: number;
  };
  readonly payments: {
    readonly stripe:
      | { readonly secretKey: string; readonly publishableKey: string; readonly webhookSecret: string; readonly apiVersion: string }
      | undefined;
    readonly flutterwave: { readonly secretKey: string; readonly webhookHash: string; readonly redirectUrl: string } | undefined;
    readonly thunes:
      | {
          readonly baseUrl: string;
          readonly apiKey: string;
          readonly apiSecret: string;
          readonly callbackUrl: string;
          readonly settlementCurrency: string;
          readonly callbackAllowedIps: readonly string[];
        }
      | undefined;
    readonly fundingTtlMinutes: number;
    readonly payoutMaxRoutes: number;
    readonly circuitFailureThreshold: number;
    readonly circuitOpenSeconds: number;
    readonly syncIntervalMs: number;
  };
  readonly admin: {
    readonly signingKey: PrivateJwk;
    readonly webauthn: { readonly rpId: string; readonly rpName: string; readonly origins: readonly string[]; readonly allowedAaguids: ReadonlySet<string> };
    readonly sessionIdleMs: number;
    readonly sessionAbsoluteMs: number;
    readonly invitationTtlMs: number;
    readonly enrollmentUrl: string;
  };
  readonly aml: {
    readonly ofacSdnUrl: string;
    readonly ofacAltUrl: string;
    readonly unListUrl: string;
    readonly openSanctionsPep: { readonly url: string; readonly apiKey: string | undefined } | undefined;
    readonly matchThreshold: number;
    readonly listsMaxAgeHours: number;
    readonly listsRefreshMs: number;
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

  if (raw.APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH !== undefined) {
    if (raw.APP_ENV !== "development" && raw.APP_ENV !== "test") {
      problems.push("APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH (autorité App Attest de test) interdit hors développement et tests");
    }
    if (raw.APPLE_APP_ATTEST_APP_IDS === undefined || raw.APPLE_APP_ATTEST_APP_IDS.length === 0) {
      problems.push("APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH exige APPLE_APP_ATTEST_APP_IDS");
    }
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

  if (raw.METRICS_PORT !== undefined && raw.METRICS_PORT === raw.PORT) {
    problems.push("METRICS_PORT doit différer de PORT : les métriques ne sont jamais servies par le port public");
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

  const onfidoValues = [raw.ONFIDO_API_TOKEN, raw.ONFIDO_WEBHOOK_TOKEN];
  const onfidoConfigured = onfidoValues.every((value) => value !== undefined);
  if (onfidoValues.some((value) => value !== undefined) && !onfidoConfigured) {
    problems.push("Onfido exige ensemble ONFIDO_API_TOKEN et ONFIDO_WEBHOOK_TOKEN");
  }
  if (onfidoConfigured && raw.ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION === undefined && raw.ONFIDO_WORKFLOW_PROOF_OF_ADDRESS === undefined) {
    problems.push("Onfido exige au moins un workflow (ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION, ONFIDO_WORKFLOW_PROOF_OF_ADDRESS)");
  }
  const smileValues = [raw.SMILE_ID_PARTNER_ID, raw.SMILE_ID_API_KEY, raw.SMILE_ID_CALLBACK_URL];
  const smileConfigured = smileValues.every((value) => value !== undefined);
  if (smileValues.some((value) => value !== undefined) && !smileConfigured) {
    problems.push("Smile ID exige ensemble SMILE_ID_PARTNER_ID, SMILE_ID_API_KEY et SMILE_ID_CALLBACK_URL");
  }
  if (strict) {
    if (raw.SMILE_ID_CALLBACK_URL !== undefined && !raw.SMILE_ID_CALLBACK_URL.startsWith("https:")) {
      problems.push("SMILE_ID_CALLBACK_URL doit être en https hors développement");
    }
  }
  if (raw.APP_ENV === "production") {
    if (!onfidoConfigured && !smileConfigured) {
      problems.push("la production exige au moins un prestataire KYC (Onfido ou Smile ID)");
    }
    if (raw.ONFIDO_API_TOKEN !== undefined && !raw.ONFIDO_API_TOKEN.startsWith("api_live")) {
      problems.push("la production exige un jeton Onfido de production (api_live…)");
    }
    if (smileConfigured && raw.SMILE_ID_ENVIRONMENT !== "production") {
      problems.push("la production exige SMILE_ID_ENVIRONMENT=production");
    }
  }

  const groups: readonly (readonly [string, readonly (string | URL | undefined)[]])[] = [
    ["Stripe (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET)", [raw.STRIPE_SECRET_KEY, raw.STRIPE_PUBLISHABLE_KEY, raw.STRIPE_WEBHOOK_SECRET]],
    ["Flutterwave (FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_HASH, FLUTTERWAVE_REDIRECT_URL)", [raw.FLUTTERWAVE_SECRET_KEY, raw.FLUTTERWAVE_WEBHOOK_HASH, raw.FLUTTERWAVE_REDIRECT_URL]],
    ["Thunes (THUNES_BASE_URL, THUNES_API_KEY, THUNES_API_SECRET, THUNES_CALLBACK_URL)", [raw.THUNES_BASE_URL, raw.THUNES_API_KEY, raw.THUNES_API_SECRET, raw.THUNES_CALLBACK_URL]],
  ];
  for (const [name, values] of groups) {
    const configured = values.filter((value) => value !== undefined).length;
    if (configured !== 0 && configured !== values.length) problems.push(`${name} : paramètres incomplets`);
  }
  if (raw.STRIPE_SECRET_KEY !== undefined && raw.STRIPE_PUBLISHABLE_KEY !== undefined
      && raw.STRIPE_SECRET_KEY.includes("_live_") !== raw.STRIPE_PUBLISHABLE_KEY.includes("_live_")) {
    problems.push("les clés Stripe secrète et publiable doivent appartenir au même mode (live ou test)");
  }
  if (strict) {
    for (const [name, url] of [["FLUTTERWAVE_REDIRECT_URL", raw.FLUTTERWAVE_REDIRECT_URL], ["THUNES_BASE_URL", raw.THUNES_BASE_URL], ["THUNES_CALLBACK_URL", raw.THUNES_CALLBACK_URL]] as const) {
      if (url !== undefined && !url.startsWith("https:")) problems.push(`${name} doit être en https hors développement`);
    }
  }
  if (raw.APP_ENV === "production") {
    if (raw.STRIPE_SECRET_KEY === undefined && raw.FLUTTERWAVE_SECRET_KEY === undefined) {
      problems.push("la production exige au moins un prestataire d'encaissement (Stripe ou Flutterwave)");
    }
    if (raw.FLUTTERWAVE_SECRET_KEY === undefined && raw.THUNES_API_KEY === undefined) {
      problems.push("la production exige au moins un prestataire de paiement sortant (Flutterwave ou Thunes)");
    }
    if (raw.STRIPE_SECRET_KEY?.includes("_test_") === true) problems.push("la production exige une clé Stripe live");
    if (raw.FLUTTERWAVE_SECRET_KEY?.startsWith("FLWSECK_TEST") === true) problems.push("la production exige une clé Flutterwave live");
    if (raw.AML_OPENSANCTIONS_PEP_URL === undefined) problems.push("la production exige une liste de personnes politiquement exposées (AML_OPENSANCTIONS_PEP_URL)");
    // Les rappels Thunes ne sont pas signés : seule la liste des adresses
    // d'émission les authentifie (l'état est de toute façon relu chez Thunes).
    if (raw.THUNES_API_KEY !== undefined && (raw.THUNES_CALLBACK_ALLOWED_IPS ?? []).length === 0) {
      problems.push("la production exige la liste des adresses d'émission des rappels Thunes (THUNES_CALLBACK_ALLOWED_IPS)");
    }
  }

  if (strict) {
    for (const [name, url] of [["AML_OFAC_SDN_URL", raw.AML_OFAC_SDN_URL], ["AML_OFAC_ALT_URL", raw.AML_OFAC_ALT_URL], ["AML_UN_LIST_URL", raw.AML_UN_LIST_URL], ["AML_OPENSANCTIONS_PEP_URL", raw.AML_OPENSANCTIONS_PEP_URL]] as const) {
      if (url !== undefined && !url.startsWith("https:")) problems.push(`${name} doit être en https hors développement`);
    }
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

  const adminSigningKey = raw.JWT_ADMIN_SIGNING_KEY;
  const publishedAdminKey = raw.JWT_ADMIN_PUBLIC_JWKS.keys.find((key) => key.kid === adminSigningKey.kid);
  if (publishedAdminKey?.x !== adminSigningKey.x) {
    problems.push(`la clé de signature ${adminSigningKey.kid} doit être publiée (même kid, même x) dans JWT_ADMIN_PUBLIC_JWKS`);
  }
  if (adminSigningKey.x === raw.JWT_CUSTOMER_SIGNING_KEY.x) problems.push("les jetons clients et personnel doivent être signés par des clés distinctes");
  for (const rpOrigin of raw.ADMIN_WEBAUTHN_ORIGINS) {
    const host = rpOrigin.hostname;
    if (host !== raw.ADMIN_WEBAUTHN_RP_ID && !host.endsWith(`.${raw.ADMIN_WEBAUTHN_RP_ID}`)) {
      problems.push(`l'origine WebAuthn ${rpOrigin.origin} n'appartient pas au domaine ${raw.ADMIN_WEBAUTHN_RP_ID}`);
    }
    if (strict && rpOrigin.protocol !== "https:") problems.push(`origine WebAuthn du personnel en clair : ${rpOrigin.origin}`);
  }
  if (!raw.ADMIN_WEBAUTHN_ORIGINS.some((origin) => origin.origin === new URL(raw.ADMIN_ENROLLMENT_URL).origin)) {
    problems.push("ADMIN_ENROLLMENT_URL doit appartenir à l'une des ADMIN_WEBAUTHN_ORIGINS");
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
    metrics: raw.METRICS_PORT === undefined ? undefined : { host: raw.METRICS_HOST, port: raw.METRICS_PORT },
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
          : {
              appIds: raw.APPLE_APP_ATTEST_APP_IDS,
              allowDevelopment: raw.APPLE_APP_ATTEST_ALLOW_DEVELOPMENT === "true",
              ...(raw.APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH === undefined ? {} : { testRootCertificatePem: readFileSync(raw.APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH, "utf8") }),
            },
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
    kyc: {
      onfido:
        raw.ONFIDO_API_TOKEN === undefined || raw.ONFIDO_WEBHOOK_TOKEN === undefined
          ? undefined
          : {
              apiToken: raw.ONFIDO_API_TOKEN,
              baseUrl: `https://api.${raw.ONFIDO_REGION}.onfido.com/v3.6`,
              webhookToken: raw.ONFIDO_WEBHOOK_TOKEN,
              workflows: {
                document_verification: raw.ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION,
                proof_of_address: raw.ONFIDO_WORKFLOW_PROOF_OF_ADDRESS,
              },
            },
      smileId:
        raw.SMILE_ID_PARTNER_ID === undefined || raw.SMILE_ID_API_KEY === undefined || raw.SMILE_ID_CALLBACK_URL === undefined
          ? undefined
          : {
              partnerId: raw.SMILE_ID_PARTNER_ID,
              apiKey: raw.SMILE_ID_API_KEY,
              environment: raw.SMILE_ID_ENVIRONMENT,
              baseUrl: raw.SMILE_ID_ENVIRONMENT === "production" ? "https://api.smileidentity.com/v1" : "https://testapi.smileidentity.com/v1",
              callbackUrl: raw.SMILE_ID_CALLBACK_URL,
              callbackToleranceSeconds: raw.SMILE_ID_CALLBACK_TOLERANCE_SECONDS,
            },
      verificationValidityDays: raw.KYC_VERIFICATION_VALIDITY_DAYS,
      sessionTtlHours: raw.KYC_SESSION_TTL_HOURS,
      maxAttemptsPer30Days: raw.KYC_MAX_ATTEMPTS_PER_30_DAYS,
      syncIntervalMs: raw.KYC_SYNC_INTERVAL_MINUTES * 60_000,
    },
    payments: {
      stripe:
        raw.STRIPE_SECRET_KEY === undefined || raw.STRIPE_PUBLISHABLE_KEY === undefined || raw.STRIPE_WEBHOOK_SECRET === undefined
          ? undefined
          : {
              secretKey: raw.STRIPE_SECRET_KEY,
              publishableKey: raw.STRIPE_PUBLISHABLE_KEY,
              webhookSecret: raw.STRIPE_WEBHOOK_SECRET,
              apiVersion: raw.STRIPE_API_VERSION,
            },
      flutterwave:
        raw.FLUTTERWAVE_SECRET_KEY === undefined || raw.FLUTTERWAVE_WEBHOOK_HASH === undefined || raw.FLUTTERWAVE_REDIRECT_URL === undefined
          ? undefined
          : { secretKey: raw.FLUTTERWAVE_SECRET_KEY, webhookHash: raw.FLUTTERWAVE_WEBHOOK_HASH, redirectUrl: raw.FLUTTERWAVE_REDIRECT_URL },
      thunes:
        raw.THUNES_BASE_URL === undefined || raw.THUNES_API_KEY === undefined || raw.THUNES_API_SECRET === undefined || raw.THUNES_CALLBACK_URL === undefined
          ? undefined
          : {
              baseUrl: raw.THUNES_BASE_URL.replace(/\/+$/, ""),
              apiKey: raw.THUNES_API_KEY,
              apiSecret: raw.THUNES_API_SECRET,
              callbackUrl: raw.THUNES_CALLBACK_URL,
              settlementCurrency: raw.THUNES_SETTLEMENT_CURRENCY,
              callbackAllowedIps: raw.THUNES_CALLBACK_ALLOWED_IPS ?? [],
            },
      fundingTtlMinutes: raw.PAYMENTS_FUNDING_TTL_MINUTES,
      payoutMaxRoutes: raw.PAYOUT_MAX_ROUTES,
      circuitFailureThreshold: raw.CIRCUIT_FAILURE_THRESHOLD,
      circuitOpenSeconds: raw.CIRCUIT_OPEN_SECONDS,
      syncIntervalMs: raw.PAYMENTS_SYNC_INTERVAL_MINUTES * 60_000,
    },
    admin: {
      signingKey: raw.JWT_ADMIN_SIGNING_KEY,
      webauthn: {
        rpId: raw.ADMIN_WEBAUTHN_RP_ID,
        rpName: raw.ADMIN_WEBAUTHN_RP_NAME,
        origins: raw.ADMIN_WEBAUTHN_ORIGINS.map((origin) => origin.origin),
        allowedAaguids: new Set((raw.ADMIN_WEBAUTHN_ALLOWED_AAGUIDS ?? []).map((aaguid) => aaguid.toLowerCase())),
      },
      sessionIdleMs: raw.ADMIN_SESSION_IDLE_MINUTES * 60_000,
      sessionAbsoluteMs: raw.ADMIN_SESSION_ABSOLUTE_HOURS * 3_600_000,
      invitationTtlMs: raw.ADMIN_INVITATION_TTL_HOURS * 3_600_000,
      enrollmentUrl: raw.ADMIN_ENROLLMENT_URL,
    },
    aml: {
      ofacSdnUrl: raw.AML_OFAC_SDN_URL,
      ofacAltUrl: raw.AML_OFAC_ALT_URL,
      unListUrl: raw.AML_UN_LIST_URL,
      openSanctionsPep: raw.AML_OPENSANCTIONS_PEP_URL === undefined ? undefined : { url: raw.AML_OPENSANCTIONS_PEP_URL, apiKey: raw.AML_OPENSANCTIONS_API_KEY },
      matchThreshold: raw.AML_MATCH_THRESHOLD,
      listsMaxAgeHours: raw.AML_LISTS_MAX_AGE_HOURS,
      listsRefreshMs: raw.AML_LISTS_REFRESH_HOURS * 3_600_000,
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
