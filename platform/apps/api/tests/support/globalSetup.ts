import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { migrate } from "@transfertplus/db/migrator";
import { seed } from "@transfertplus/db/seeder";
import pg from "pg";

/**
 * Prépare une base PostgreSQL de test vierge : recréation, migrations,
 * données de référence. La base doit se nommer *_test (garde-fou).
 *
 * En fin de suite, après des centaines de transferts, remboursements,
 * ajustements et décisions du personnel, la base doit rester intègre : chaîne
 * du registre, soldes recalculés et chaîne d'audit sont revérifiés.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("TEST_DATABASE_URL est obligatoire pour les tests de l'API");
  }
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
    throw new Error(`la base de test doit se terminer par _test (reçu : ${databaseName})`);
  }

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: maintenance.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${databaseName}" ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }

  const require = createRequire(import.meta.url);
  const dbPackageRoot = dirname(require.resolve("@transfertplus/db/package.json"));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, join(dbPackageRoot, "migrations"));
    await seed(client, join(dbPackageRoot, "seed"));
    await client.query("UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF', 'GBP', 'JPY', 'BHD')");
  } finally {
    await client.end();
  }

  return async () => {
    const verifier = new pg.Client({ connectionString: url });
    await verifier.connect();
    try {
      const problems: string[] = [];
      const chain = await verifier.query<{ problem: string }>("SELECT problem FROM ledger.verify_chain()");
      problems.push(...chain.rows.map((row) => `registre : ${row.problem}`));
      const balances = await verifier.query<Record<string, unknown>>("SELECT * FROM ledger.verify_balances()");
      problems.push(...balances.rows.map((row) => `solde incohérent : ${JSON.stringify(row)}`));
      const audit = await verifier.query<{ problem: string }>("SELECT problem FROM audit.verify_chain()");
      problems.push(...audit.rows.map((row) => `audit : ${row.problem}`));
      const trial = await verifier.query<{ currency: string; total_debits: string; total_credits: string }>(
        "SELECT currency, total_debits::text, total_credits::text FROM ledger.trial_balance WHERE NOT is_balanced",
      );
      problems.push(...trial.rows.map((row) => `balance déséquilibrée en ${row.currency} : débits ${row.total_debits}, crédits ${row.total_credits}`));
      if (problems.length > 0) throw new Error(`Intégrité rompue en fin de suite :\n  - ${problems.join("\n  - ")}`);
    } finally {
      await verifier.end();
    }
  };
}
