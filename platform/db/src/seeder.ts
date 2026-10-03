import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";

import { describeError } from "./migrator.js";

const SEED_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Applique les fichiers de données de référence, dans l'ordre. Chaque fichier
 * est idempotent (ON CONFLICT / UPDATE conditionnels) et exécuté dans sa
 * propre transaction.
 */
export async function seed(client: Client, directory: string): Promise<readonly string[]> {
  const applied: string[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith(".sql")) continue;
    if (!SEED_FILE_PATTERN.test(fileName)) {
      throw new Error(`Nom de fichier de données invalide : ${fileName}`);
    }
    const sql = readFileSync(join(directory, fileName), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      applied.push(fileName);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw new Error(`Échec du chargement de ${fileName} : ${describeError(error)}`, { cause: error });
    }
  }
  return applied;
}
