import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import type { DatabaseConfig } from "./config.js";
import { checkIntegrity, isHealthy } from "./integrity.js";
import { describeError, migrate } from "./migrator.js";
import { seed } from "./seeder.js";

export interface TestPaths {
  readonly migrationsDir: string;
  readonly seedDir: string;
  readonly sqlTestsDir: string;
  readonly fixturesFile: string;
}

export interface TestOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export type ConcurrencySuite = (connectionString: string, ssl: DatabaseConfig["ssl"]) => Promise<readonly TestOutcome[]>;

/**
 * Recrée la base de test, applique migrations et données de référence, puis
 * exécute :
 *   1. les tests SQL (chacun dans une transaction annulée à la fin, précédée
 *      des fixtures communes) ;
 *   2. la suite de concurrence (transactions réelles, connexions parallèles) ;
 *   3. le contrôle d'intégrité global.
 */
export async function runTests(
  config: DatabaseConfig,
  paths: TestPaths,
  concurrencySuite: ConcurrencySuite,
): Promise<readonly TestOutcome[]> {
  const testUrl = config.testDatabaseUrl;
  if (testUrl === undefined) throw new Error("TEST_DATABASE_URL est obligatoire pour lancer les tests");
  if (config.appEnv !== "development" && config.appEnv !== "test") {
    throw new Error(`Les tests recréent la base : interdit en ${config.appEnv}`);
  }
  const parsedUrl = new URL(testUrl);
  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
    throw new Error(`Le nom de la base de test doit se terminer par _test (reçu : « ${databaseName} »)`);
  }

  await recreateDatabase(parsedUrl, databaseName, config.ssl);

  const outcomes: TestOutcome[] = [];
  const client = new pg.Client({ connectionString: testUrl, ssl: config.ssl });
  await client.connect();
  try {
    await migrate(client, paths.migrationsDir);
    await seed(client, paths.seedDir);

    const fixtures = readFileSync(paths.fixturesFile, "utf8");
    const testFiles = readdirSync(paths.sqlTestsDir)
      .filter((fileName) => fileName.endsWith(".test.sql"))
      .sort();
    for (const fileName of testFiles) {
      const sql = readFileSync(join(paths.sqlTestsDir, fileName), "utf8");
      const startedAt = performance.now();
      try {
        await client.query("BEGIN");
        await client.query(fixtures);
        await client.query(sql);
        outcomes.push({ name: `sql/${fileName}`, passed: true, durationMs: elapsed(startedAt) });
      } catch (error: unknown) {
        outcomes.push({
          name: `sql/${fileName}`,
          passed: false,
          durationMs: elapsed(startedAt),
          error: describeError(error),
        });
      } finally {
        await client.query("ROLLBACK");
      }
    }
  } finally {
    await client.end();
  }

  outcomes.push(...(await concurrencySuite(testUrl, config.ssl)));

  const integrityClient = new pg.Client({ connectionString: testUrl, ssl: config.ssl });
  await integrityClient.connect();
  const startedAt = performance.now();
  try {
    const report = await checkIntegrity(integrityClient);
    const problems = [
      ...report.chainProblems,
      ...report.balanceProblems,
      ...report.trialBalanceProblems,
      ...report.auditChainProblems,
    ];
    outcomes.push(
      isHealthy(report)
        ? { name: "integrity/final", passed: true, durationMs: elapsed(startedAt) }
        : { name: "integrity/final", passed: false, durationMs: elapsed(startedAt), error: problems.join(" | ") },
    );
  } finally {
    await integrityClient.end();
  }
  return outcomes;
}

async function recreateDatabase(testUrl: URL, databaseName: string, ssl: DatabaseConfig["ssl"]): Promise<void> {
  const maintenanceUrl = new URL(testUrl.toString());
  maintenanceUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString(), ssl });
  await admin.connect();
  try {
    const quoted = `"${databaseName.replaceAll('"', '""')}"`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoted} ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
