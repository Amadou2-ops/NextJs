import pg from "pg";
import type { Logger } from "pino";

import type { AppConfig } from "../config/env.js";

/**
 * Pool de connexions PostgreSQL.
 *
 * - bigint (int8) est converti en BigInt JavaScript : les montants ne
 *   transitent jamais par un `number` flottant.
 * - numeric reste une chaîne (taux de change exacts).
 * - Délais de garde : une requête ou une transaction oubliée ne peut pas
 *   bloquer des verrous du registre indéfiniment.
 *
 * L'URL de connexion désigne un identifiant de l'environnement rattaché au
 * rôle de groupe app_api (voir db/migrations/0016).
 */

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const INT8_ARRAY_OID = 1016;

function createTypeParsers(): pg.CustomTypesConfig {
  const overrides = new pg.TypeOverrides();
  overrides.setTypeParser(INT8_OID, "text", (value: string) => BigInt(value));
  overrides.setTypeParser(NUMERIC_OID, "text", (value: string) => value);
  overrides.setTypeParser(INT8_ARRAY_OID, "text", (value: string) => {
    const inner = value.slice(1, -1);
    return inner.length === 0 ? [] : inner.split(",").map((item) => BigInt(item));
  });
  return overrides;
}

export type DatabasePool = pg.Pool;

export function createDatabasePool(config: AppConfig, logger: Logger): DatabasePool {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    maxLifetimeSeconds: 1_800,
    application_name: `transfertplus-api/${config.appVersion}`,
    statement_timeout: config.database.statementTimeoutMs,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
    types: createTypeParsers(),
  });

  pool.on("error", (error) => {
    // Erreur sur une connexion inactive (coupure réseau, redémarrage) : le
    // pool la retire ; on journalise sans faire tomber le processus.
    logger.error({ err: error }, "connexion PostgreSQL inactive en erreur");
  });

  return pool;
}

export async function checkDatabase(pool: DatabasePool): Promise<void> {
  const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  if (result.rows[0]?.ok !== 1) throw new Error("réponse inattendue de PostgreSQL");
}
