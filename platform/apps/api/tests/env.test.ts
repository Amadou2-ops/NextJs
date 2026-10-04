import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config/env.js";
import { createTestKeys } from "./support/fixtures.js";

const keys = await createTestKeys();

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: "production",
    DATABASE_URL: "postgres://api:secret@db.internal:5432/transfertplus",
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_SSL_CA_PATH: "/etc/hosts",
    REDIS_URL: "rediss://cache.internal:6380",
    CORS_ALLOWED_ORIGINS: "https://app.transfertplus.com,https://admin.transfertplus.com",
    JWT_ISSUER: "https://auth.transfertplus.com",
    JWT_CUSTOMER_PUBLIC_JWKS: JSON.stringify({ keys: [keys.customer.publicJwk] }),
    JWT_ADMIN_PUBLIC_JWKS: JSON.stringify({ keys: [keys.admin.publicJwk] }),
    PII_KEYRING: JSON.stringify({ activeKeyId: "pii-2026-01", keys: { "pii-2026-01": randomBytes(32).toString("base64") } }),
    BLIND_INDEX_KEY: randomBytes(32).toString("base64"),
    JWT_CUSTOMER_SIGNING_KEY: JSON.stringify(keys.customer.privateJwk),
    JWT_ADMIN_SIGNING_KEY: JSON.stringify(keys.admin.privateJwk),
    ADMIN_WEBAUTHN_RP_ID: "admin.transfertplus.com",
    ADMIN_WEBAUTHN_ORIGINS: "https://admin.transfertplus.com",
    ADMIN_ENROLLMENT_URL: "https://admin.transfertplus.com/enrolement",
    OTP_HMAC_KEY: randomBytes(32).toString("base64"),
    SMS_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "t".repeat(32),
    TWILIO_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}`,
    WEBAUTHN_RP_ID: "transfertplus.com",
    WEBAUTHN_ORIGINS: "https://app.transfertplus.com",
    TSA_URL: "https://tsa.example.com/rfc3161",
    TSA_TRUSTED_CERTS_PATH: "/etc/hosts",
    OPEN_EXCHANGE_RATES_APP_ID: "a".repeat(32),
    ONFIDO_API_TOKEN: `api_live.${"c".repeat(32)}`,
    ONFIDO_WEBHOOK_TOKEN: "d".repeat(32),
    ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
    FLUTTERWAVE_SECRET_KEY: `FLWSECK-${"e".repeat(32)}-X`,
    FLUTTERWAVE_WEBHOOK_HASH: "f".repeat(32),
    FLUTTERWAVE_REDIRECT_URL: "https://app.transfertplus.com/paiement/retour",
    AML_OPENSANCTIONS_PEP_URL: "https://data.opensanctions.org/datasets/latest/peps/targets.simple.csv",
    AML_OPENSANCTIONS_API_KEY: "o".repeat(32),
    ...overrides,
  };
}

describe("configuration", () => {
  it("accepte une configuration de production conforme", () => {
    const config = loadConfig(baseEnv());
    expect(config.isProduction).toBe(true);
    expect([...config.corsAllowedOrigins]).toEqual(["https://app.transfertplus.com", "https://admin.transfertplus.com"]);
    expect(config.database.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.kyc.onfido).toMatchObject({ baseUrl: "https://api.eu.onfido.com/v3.6", workflows: { proof_of_address: undefined } });
    expect(config.kyc.smileId).toBeUndefined();
    expect(loadConfig(baseEnv({ ONFIDO_REGION: "us" })).kyc.onfido?.baseUrl).toBe("https://api.us.onfido.com/v3.6");
    expect(config.payments.flutterwave).toBeDefined();
    expect(config.payments.stripe).toBeUndefined();
    const thunes = loadConfig(
      baseEnv({ THUNES_BASE_URL: "https://api-mt.thunes.com/", THUNES_API_KEY: "key-0001", THUNES_API_SECRET: "s".repeat(24), THUNES_CALLBACK_URL: "https://api.transfertplus.com/v1/webhooks/thunes", THUNES_CALLBACK_ALLOWED_IPS: "203.0.113.10,2001:db8::1" }),
    ).payments.thunes;
    expect(thunes).toMatchObject({ baseUrl: "https://api-mt.thunes.com", settlementCurrency: "USD", callbackAllowedIps: ["203.0.113.10", "2001:db8::1"] });
  });

  it.each([
    ["TLS base désactivé", { DATABASE_SSL_MODE: "disable" }],
    ["TLS base sans vérification", { DATABASE_SSL_MODE: "require" }],
    ["Redis sans TLS", { REDIS_URL: "redis://cache.internal:6379" }],
    ["origine CORS en http", { CORS_ALLOWED_ORIGINS: "http://app.transfertplus.com" }],
    ["origine CORS locale", { CORS_ALLOWED_ORIGINS: "https://localhost:3000" }],
    ["journal en debug", { LOG_LEVEL: "debug" }],
    ["émetteur JWT en http", { JWT_ISSUER: "http://auth.transfertplus.com" }],
    ["SMS journalisés", { SMS_PROVIDER: "log" }],
    ["contrôle des fuites désactivé", { PASSWORD_BREACH_CHECK: "disabled" }],
    ["App Attest de développement", { APPLE_APP_ATTEST_APP_IDS: "ABCDE12345.com.transfertplus.app", APPLE_APP_ATTEST_ALLOW_DEVELOPMENT: "true" }],
    ["origine WebAuthn en http", { WEBAUTHN_ORIGINS: "http://app.transfertplus.com" }],
    ["registre sans ancrage externe", { TSA_URL: "", TSA_TRUSTED_CERTS_PATH: "" }],
    ["aucun fournisseur de taux", { OPEN_EXCHANGE_RATES_APP_ID: "" }],
    ["aucun prestataire KYC", { ONFIDO_API_TOKEN: "", ONFIDO_WEBHOOK_TOKEN: "" }],
    ["aucun prestataire de paiement", { FLUTTERWAVE_SECRET_KEY: "", FLUTTERWAVE_WEBHOOK_HASH: "", FLUTTERWAVE_REDIRECT_URL: "" }],
    ["clé de signature du personnel non publiée", { JWT_ADMIN_SIGNING_KEY: JSON.stringify(keys.customer.privateJwk) }],
    ["origine WebAuthn du personnel hors domaine", { ADMIN_WEBAUTHN_ORIGINS: "https://admin.transfertplus.net", ADMIN_ENROLLMENT_URL: "https://admin.transfertplus.net/enrolement" }],
    ["page d'enrôlement hors dashboard", { ADMIN_ENROLLMENT_URL: "https://app.transfertplus.com/enrolement" }],
    ["aucune liste PEP", { AML_OPENSANCTIONS_PEP_URL: "", AML_OPENSANCTIONS_API_KEY: "" }],
    ["liste AML en clair", { AML_UN_LIST_URL: "http://scsanctions.un.org/resources/xml/en/consolidated.xml" }],
    ["clé Flutterwave de test", { FLUTTERWAVE_SECRET_KEY: `FLWSECK_TEST-${"e".repeat(32)}-X` }],
    [
      "rappels Thunes acceptés de toute adresse",
      { THUNES_BASE_URL: "https://api-mt.thunes.com", THUNES_API_KEY: "key-0001", THUNES_API_SECRET: "s".repeat(24), THUNES_CALLBACK_URL: "https://api.transfertplus.com/v1/webhooks/thunes" },
    ],
    [
      "clé Stripe de test",
      { STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}`, STRIPE_PUBLISHABLE_KEY: `pk_test_${"b".repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${"c".repeat(32)}` },
    ],
    ["jeton Onfido de bac à sable", { ONFIDO_API_TOKEN: `api_sandbox.${"c".repeat(32)}` }],
    [
      "Smile ID en bac à sable",
      { SMILE_ID_PARTNER_ID: "2343", SMILE_ID_API_KEY: "k".repeat(32), SMILE_ID_CALLBACK_URL: "https://api.transfertplus.com/v1/webhooks/smile-id" },
    ],
  ])("refuse en production : %s", (_label, overrides) => {
    expect(() => loadConfig(baseEnv(overrides))).toThrow(ConfigurationError);
  });

  it.each([
    ["origine avec chemin", { CORS_ALLOWED_ORIGINS: "https://app.transfertplus.com/" }],
    ["joker CORS", { CORS_ALLOWED_ORIGINS: "*" }],
    ["clé PII trop courte", { PII_KEYRING: JSON.stringify({ activeKeyId: "k1", keys: { k1: randomBytes(16).toString("base64") } }) }],
    ["clé active absente", { PII_KEYRING: JSON.stringify({ activeKeyId: "k2", keys: { k1: randomBytes(32).toString("base64") } }) }],
    ["JWKS avec algorithme RS256", { JWT_CUSTOMER_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...keys.customer.publicJwk, alg: "RS256" }] }) }],
    ["même clé pour clients et personnel", { JWT_ADMIN_PUBLIC_JWKS: JSON.stringify({ keys: [keys.customer.publicJwk] }) }],
    ["JSON invalide", { JWT_ADMIN_PUBLIC_JWKS: "{" }],
    ["DATABASE_URL absente", { DATABASE_URL: "" }],
    ["clé de signature non publiée", { JWT_CUSTOMER_SIGNING_KEY: JSON.stringify({ ...keys.admin.privateJwk }) }],
    ["Twilio incomplet", { TWILIO_AUTH_TOKEN: "" }],
    ["origine WebAuthn hors domaine", { WEBAUTHN_ORIGINS: "https://evil.example" }],
    ["Play Integrity incomplet", { ANDROID_PACKAGE_NAME: "com.transfertplus.app" }],
    ["TSA sans certificats", { TSA_TRUSTED_CERTS_PATH: "" }],
    ["identifiant Open Exchange Rates invalide", { OPEN_EXCHANGE_RATES_APP_ID: "not-an-app-id" }],
    ["fournisseur principal non configuré", { FX_PRIMARY_PROVIDER: "fixer" }],
    ["clé Fixer invalide", { FIXER_API_KEY: "short" }],
    ["Onfido sans jeton de webhook", { ONFIDO_WEBHOOK_TOKEN: "" }],
    ["Onfido sans workflow", { ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "" }],
    ["workflow Onfido invalide", { ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "workflow-1" }],
    ["Smile ID incomplet", { SMILE_ID_PARTNER_ID: "2343" }],
    ["Stripe incomplet", { STRIPE_SECRET_KEY: `sk_live_${"a".repeat(24)}` }],
    [
      "clés Stripe de modes différents",
      { STRIPE_SECRET_KEY: `sk_live_${"a".repeat(24)}`, STRIPE_PUBLISHABLE_KEY: `pk_test_${"b".repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${"c".repeat(32)}` },
    ],
    ["Thunes incomplet", { THUNES_BASE_URL: "https://api-mt.thunes.com", THUNES_API_KEY: "key-0001" }],
    ["retour Flutterwave en http", { FLUTTERWAVE_REDIRECT_URL: "http://app.transfertplus.com/retour" }],
    ["rappel Smile ID en http", { SMILE_ID_PARTNER_ID: "2343", SMILE_ID_API_KEY: "k".repeat(32), SMILE_ID_ENVIRONMENT: "production", SMILE_ID_CALLBACK_URL: "http://api.transfertplus.com/cb" }],
  ])("refuse dans tous les environnements : %s", (_label, overrides) => {
    expect(() => loadConfig(baseEnv(overrides))).toThrow(ConfigurationError);
  });

  it("refuse une clé d'index aveugle identique à une clé de chiffrement", () => {
    const key = randomBytes(32).toString("base64");
    expect(() =>
      loadConfig(baseEnv({ PII_KEYRING: JSON.stringify({ activeKeyId: "k1", keys: { k1: key } }), BLIND_INDEX_KEY: key })),
    ).toThrow(/BLIND_INDEX_KEY/);
  });

  it("autorise le développement local sans TLS", () => {
    const config = loadConfig(
      baseEnv({
        APP_ENV: "development",
        DATABASE_SSL_MODE: "disable",
        REDIS_URL: "redis://127.0.0.1:6379",
        CORS_ALLOWED_ORIGINS: "http://localhost:3000",
        JWT_ISSUER: "http://localhost:8080",
        LOG_LEVEL: "debug",
        SMS_PROVIDER: "log",
        WEBAUTHN_RP_ID: "localhost",
        WEBAUTHN_ORIGINS: "http://localhost:3000",
      }),
    );
    expect(config.database.ssl).toBe(false);
  });
});
