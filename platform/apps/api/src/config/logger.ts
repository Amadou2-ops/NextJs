import { pino } from "pino";
import type { Logger, LoggerOptions } from "pino";

import type { AppConfig } from "./env.js";

/**
 * Journalisation structurée (JSON). Les secrets et données personnelles sont
 * masqués à la source : un journal applicatif n'est jamais une copie de la
 * base clients.
 */
export const REDACTED_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-device-signature\"]",
  "req.headers[\"idempotency-key\"]",
  "res.headers[\"set-cookie\"]",
  "*.password",
  "*.newPassword",
  "*.pin",
  "*.otp",
  "*.code",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.phone",
  "*.email",
  "*.firstName",
  "*.lastName",
  "*.dateOfBirth",
  "*.address",
  "*.iban",
  "*.accountNumber",
  "*.documentNumber",
];

export function createLogger(config: Pick<AppConfig, "logLevel" | "appEnv" | "appVersion">): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: { service: "transfertplus-api", env: config.appEnv, version: config.appVersion },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], censor: "[MASQUÉ]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return pino(options);
}
