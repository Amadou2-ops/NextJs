import { readFileSync } from "node:fs";

import { z } from "zod";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("verify-full"),
  DATABASE_SSL_CA_PATH: z.string().optional(),
});

export type AppEnvironment = z.infer<typeof environmentSchema>["APP_ENV"];
export type SslMode = z.infer<typeof environmentSchema>["DATABASE_SSL_MODE"];

export interface SslSettings {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string;
}

export interface DatabaseConfig {
  readonly appEnv: AppEnvironment;
  readonly databaseUrl: string;
  readonly testDatabaseUrl: string | undefined;
  readonly ssl: SslSettings | false;
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/**
 * Lit et valide la configuration. Toute incohérence de sécurité est fatale :
 * TLS ne peut pas être désactivé hors développement/test, et la vérification
 * du certificat est obligatoire en production.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = environmentSchema.safeParse({
    APP_ENV: env["APP_ENV"],
    DATABASE_URL: env["DATABASE_URL"],
    TEST_DATABASE_URL: emptyToUndefined(env["TEST_DATABASE_URL"]),
    DATABASE_SSL_MODE: emptyToUndefined(env["DATABASE_SSL_MODE"]),
    DATABASE_SSL_CA_PATH: emptyToUndefined(env["DATABASE_SSL_CA_PATH"]),
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Configuration base de données invalide — ${details}`);
  }
  const values = parsed.data;

  if (values.DATABASE_SSL_MODE === "disable" && (values.APP_ENV === "staging" || values.APP_ENV === "production")) {
    throw new ConfigurationError(`DATABASE_SSL_MODE=disable est interdit en ${values.APP_ENV}`);
  }
  if (values.APP_ENV === "production" && values.DATABASE_SSL_MODE !== "verify-full") {
    throw new ConfigurationError("La production exige DATABASE_SSL_MODE=verify-full");
  }

  return {
    appEnv: values.APP_ENV,
    databaseUrl: values.DATABASE_URL,
    testDatabaseUrl: values.TEST_DATABASE_URL,
    ssl: buildSsl(values.DATABASE_SSL_MODE, values.DATABASE_SSL_CA_PATH),
  };
}

function buildSsl(mode: SslMode, caPath: string | undefined): SslSettings | false {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return caPath === undefined
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ca: readFileSync(caPath, "utf8") };
    case "verify-full":
      if (caPath === undefined) {
        throw new ConfigurationError("DATABASE_SSL_MODE=verify-full exige DATABASE_SSL_CA_PATH");
      }
      return { rejectUnauthorized: true, ca: readFileSync(caPath, "utf8") };
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}
