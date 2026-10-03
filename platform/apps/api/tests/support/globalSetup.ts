import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { migrate } from "@transfertplus/db/migrator";
import { seed } from "@transfertplus/db/seeder";
import pg from "pg";

/**
 * Prépare une base PostgreSQL de test vierge : recréation, migrations,
 * données de référence. La base doit se nommer *_test (garde-fou).
 */
export default async function setup(): Promise<void> {
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
}
