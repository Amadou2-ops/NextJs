import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Répertoire d'état d'une exécution (ignoré par git) : contexte, journaux, coffre des clés. */
export const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".runtime");
export const CONTEXT_FILE = join(RUNTIME_DIR, "context.json");

export interface Founder {
  readonly email: string;
  readonly name: string;
  readonly enrollmentUrl: string;
}

/** Ce que la pile démarrée (scripts/stack.ts) transmet aux tests. */
export interface E2EContext {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly adminUrl: string;
  /** Connexion propriétaire de la base de test : uniquement pour simuler un prestataire (décision KYC). */
  readonly ownerDatabaseUrl: string;
  /** Journal JSON de l'API (SMS de développement). */
  readonly apiLogFile: string;
  /** Trousseau PII de l'API de test (identité déclarée chiffrée comme par le service KYC). */
  readonly piiKeyId: string;
  readonly piiKeyBase64: string;
  readonly founders: readonly [Founder, Founder];
}

let cached: E2EContext | undefined;

export function e2eContext(): E2EContext {
  cached ??= JSON.parse(readFileSync(CONTEXT_FILE, "utf8")) as E2EContext;
  return cached;
}
