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
    ...overrides,
  };
}

describe("configuration", () => {
  it("accepte une configuration de production conforme", () => {
    const config = loadConfig(baseEnv());
    expect(config.isProduction).toBe(true);
    expect([...config.corsAllowedOrigins]).toEqual(["https://app.transfertplus.com", "https://admin.transfertplus.com"]);
    expect(config.database.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it.each([
    ["TLS base désactivé", { DATABASE_SSL_MODE: "disable" }],
    ["TLS base sans vérification", { DATABASE_SSL_MODE: "require" }],
    ["Redis sans TLS", { REDIS_URL: "redis://cache.internal:6379" }],
    ["origine CORS en http", { CORS_ALLOWED_ORIGINS: "http://app.transfertplus.com" }],
    ["origine CORS locale", { CORS_ALLOWED_ORIGINS: "https://localhost:3000" }],
    ["journal en debug", { LOG_LEVEL: "debug" }],
    ["émetteur JWT en http", { JWT_ISSUER: "http://auth.transfertplus.com" }],
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
      }),
    );
    expect(config.database.ssl).toBe(false);
  });
});
