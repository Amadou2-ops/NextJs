import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { runLedgerConcurrencySuite } from "../tests/ledger-concurrency.js";
import { ConfigurationError, loadDatabaseConfig } from "./config.js";
import type { DatabaseConfig } from "./config.js";
import { checkIntegrity, isHealthy } from "./integrity.js";
import { describeError, getStatus, migrate, MigrationIntegrityError } from "./migrator.js";
import { seed } from "./seeder.js";
import { runTests } from "./test-runner.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(packageRoot, "migrations");
const SEED_DIR = join(packageRoot, "seed");
const SQL_TESTS_DIR = join(packageRoot, "tests", "sql");
const FIXTURES_FILE = join(packageRoot, "tests", "fixtures.sql");

type Command = "migrate" | "status" | "verify" | "seed" | "test";
const COMMANDS: readonly Command[] = ["migrate", "status", "verify", "seed", "test"];

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function withClient<T>(config: DatabaseConfig, task: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    application_name: "transfertplus-db-cli",
  });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

async function commandMigrate(config: DatabaseConfig): Promise<number> {
  const result = await withClient(config, (client) => migrate(client, MIGRATIONS_DIR));
  if (result.appliedNow.length === 0) {
    print("Base à jour : aucune migration en attente.");
  } else {
    for (const applied of result.appliedNow) print(`✔ ${applied.fileName} (${applied.executionMs} ms)`);
    print(`${result.appliedNow.length} migration(s) appliquée(s).`);
  }
  return 0;
}

async function commandStatus(config: DatabaseConfig): Promise<number> {
  const status = await withClient(config, (client) => getStatus(client, MIGRATIONS_DIR));
  for (const applied of status.applied) {
    print(`appliquée  ${String(applied.version).padStart(4, "0")}_${applied.name}  ${applied.appliedAt.toISOString()}  par ${applied.appliedBy}`);
  }
  for (const pending of status.pending) print(`en attente ${pending.fileName}`);
  for (const problem of status.problems) print(`✘ ${problem}`);
  return status.problems.length === 0 ? 0 : 1;
}

async function commandVerify(config: DatabaseConfig): Promise<number> {
  return withClient(config, async (client) => {
    const status = await getStatus(client, MIGRATIONS_DIR);
    const report = await checkIntegrity(client);
    print(`Migrations : ${status.applied.length} appliquée(s), ${status.pending.length} en attente.`);
    print(`Registre : ${report.journalCount} journaux. Audit : ${report.auditEventCount} événements.`);
    const problems = [
      ...status.problems,
      ...report.chainProblems,
      ...report.balanceProblems,
      ...report.trialBalanceProblems,
      ...report.auditChainProblems,
    ];
    if (problems.length === 0 && isHealthy(report)) {
      print("✔ Intégrité vérifiée : chaîne d'empreintes, soldes, balance générale et audit cohérents.");
      return 0;
    }
    for (const problem of problems) print(`✘ ${problem}`);
    return 2;
  });
}

async function commandSeed(config: DatabaseConfig): Promise<number> {
  const applied = await withClient(config, (client) => seed(client, SEED_DIR));
  for (const fileName of applied) print(`✔ ${fileName}`);
  return 0;
}

async function commandTest(config: DatabaseConfig): Promise<number> {
  const outcomes = await runTests(
    config,
    { migrationsDir: MIGRATIONS_DIR, seedDir: SEED_DIR, sqlTestsDir: SQL_TESTS_DIR, fixturesFile: FIXTURES_FILE },
    runLedgerConcurrencySuite,
  );
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.passed) {
      print(`✔ ${outcome.name} (${outcome.durationMs} ms)`);
    } else {
      failures += 1;
      print(`✘ ${outcome.name} (${outcome.durationMs} ms)\n    ${outcome.error ?? "échec sans message"}`);
    }
  }
  print(`${outcomes.length - failures}/${outcomes.length} tests réussis.`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    print(`Usage : cli <${COMMANDS.join("|")}>`);
    return 64;
  }
  const config = loadDatabaseConfig();
  switch (command) {
    case "migrate":
      return commandMigrate(config);
    case "status":
      return commandStatus(config);
    case "verify":
      return commandVerify(config);
    case "seed":
      return commandSeed(config);
    case "test":
      return commandTest(config);
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigurationError || error instanceof MigrationIntegrityError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`Erreur : ${describeError(error)}\n`);
    }
    process.exitCode = 1;
  });
