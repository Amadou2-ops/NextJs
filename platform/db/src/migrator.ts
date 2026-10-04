import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";

/**
 * Migrateur SQL minimal et vérifiable :
 *   - fichiers NNNN_nom.sql appliqués dans l'ordre, chacun dans sa propre
 *     transaction (tout ou rien) ;
 *   - empreinte SHA-256 de chaque fichier enregistrée : un fichier déjà
 *     appliqué puis modifié bloque toute nouvelle migration (falsification ou
 *     erreur de manipulation) ;
 *   - verrou consultatif : deux déploiements simultanés ne peuvent pas migrer
 *     en même temps.
 */

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Clé arbitraire et stable du verrou consultatif des migrations.
const MIGRATION_LOCK_KEY = 7_428_190_334_105_771n;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly appliedBy: string;
  readonly executionMs: number;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
  readonly problems: readonly string[];
}

export class MigrationIntegrityError extends Error {
  override readonly name = "MigrationIntegrityError";
  constructor(readonly problems: readonly string[]) {
    super(`Intégrité des migrations compromise :\n - ${problems.join("\n - ")}`);
  }
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function loadMigrationFiles(directory: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith(".sql")) continue;
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationIntegrityError([`nom de fichier de migration invalide : ${fileName}`]);
    }
    const [, versionText, name] = match;
    if (versionText === undefined || name === undefined) {
      throw new MigrationIntegrityError([`nom de fichier de migration illisible : ${fileName}`]);
    }
    const sql = readFileSync(join(directory, fileName), "utf8");
    files.push({ version: Number(versionText), name, fileName, sql, checksum: sha256Hex(sql) });
  }

  const problems: string[] = [];
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      problems.push(`numérotation discontinue : ${file.fileName} devrait porter le numéro ${String(index + 1).padStart(4, "0")}`);
    }
  });
  if (problems.length > 0) throw new MigrationIntegrityError(problems);
  return files;
}

async function ensureMetaTable(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS migration_meta;
    REVOKE ALL ON SCHEMA migration_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS migration_meta.schema_migrations (
        version         integer     PRIMARY KEY,
        name            text        NOT NULL,
        checksum_sha256 text        NOT NULL,
        applied_at      timestamptz NOT NULL DEFAULT now(),
        applied_by      text        NOT NULL DEFAULT current_user,
        execution_ms    integer     NOT NULL,
        CONSTRAINT schema_migrations_checksum_format CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
    );
  `);
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum_sha256: string;
  applied_at: Date;
  applied_by: string;
  execution_ms: number;
}

async function readApplied(client: Client): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigrationRow>(
    `SELECT version, name, checksum_sha256, applied_at, applied_by, execution_ms
       FROM migration_meta.schema_migrations
      ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum_sha256,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    executionMs: row.execution_ms,
  }));
}

function compare(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationStatus {
  const problems: string[] = [];
  const filesByVersion = new Map(files.map((file) => [file.version, file] as const));

  applied.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      problems.push(`historique appliqué discontinu à la version ${migration.version}`);
    }
    const file = filesByVersion.get(migration.version);
    if (file === undefined) {
      problems.push(`migration ${migration.version} (${migration.name}) appliquée mais absente du dépôt`);
      return;
    }
    if (file.name !== migration.name) {
      problems.push(`migration ${migration.version} renommée : « ${migration.name} » → « ${file.name} »`);
    }
    if (file.checksum !== migration.checksum) {
      problems.push(
        `migration ${file.fileName} modifiée après application (attendu ${migration.checksum}, trouvé ${file.checksum})`,
      );
    }
  });

  const lastApplied = applied.at(-1)?.version ?? 0;
  const pending = files.filter((file) => file.version > lastApplied);
  return { applied, pending, problems };
}

export async function getStatus(client: Client, directory: string): Promise<MigrationStatus> {
  const files = loadMigrationFiles(directory);
  await ensureMetaTable(client);
  return compare(files, await readApplied(client));
}

export interface MigrateResult {
  readonly appliedNow: readonly { readonly fileName: string; readonly executionMs: number }[];
}

export async function migrate(client: Client, directory: string): Promise<MigrateResult> {
  const files = loadMigrationFiles(directory);
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
  try {
    await ensureMetaTable(client);
    const status = compare(files, await readApplied(client));
    if (status.problems.length > 0) throw new MigrationIntegrityError(status.problems);

    const appliedNow: { fileName: string; executionMs: number }[] = [];
    for (const file of status.pending) {
      const startedAt = performance.now();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '15min'");
        await client.query(file.sql);
        const executionMs = Math.round(performance.now() - startedAt);
        await client.query(
          `INSERT INTO migration_meta.schema_migrations (version, name, checksum_sha256, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [file.version, file.name, file.checksum, executionMs],
        );
        await client.query("COMMIT");
        appliedNow.push({ fileName: file.fileName, executionMs });
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw new Error(`Échec de la migration ${file.fileName} : ${describeError(error)}`, { cause: error });
      }
    }
    return { appliedNow };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const pgError = error as Error & { code?: string; detail?: string; hint?: string; position?: string };
    return [
      pgError.message,
      pgError.code === undefined ? undefined : `SQLSTATE ${pgError.code}`,
      pgError.detail === undefined ? undefined : `détail : ${pgError.detail}`,
      pgError.hint === undefined ? undefined : `indice : ${pgError.hint}`,
      pgError.position === undefined ? undefined : `position : ${pgError.position}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" — ");
  }
  return String(error);
}
