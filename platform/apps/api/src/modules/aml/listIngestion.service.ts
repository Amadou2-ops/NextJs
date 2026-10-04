import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { ListEntry, ListSource } from "./lists/sources.js";
import { normalizeForScreening } from "./nameMatching.js";

/**
 * Import des listes de criblage. Chaque import crée une nouvelle version
 * (immuable, empreinte du contenu) puis bascule la version courante dans la
 * même transaction : un criblage voit toujours une liste complète. Une liste
 * nettement plus courte que la précédente (fichier tronqué, erreur du
 * diffuseur) est refusée et signalée au lieu de remplacer la liste en
 * vigueur.
 */

const BATCH_SIZE = 1000;

export interface IngestionResult {
  readonly source: string;
  readonly status: "updated" | "unchanged";
  readonly version: string;
  readonly entryCount: number;
}

export class ListIngestionService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    private readonly options: { readonly minRetainedRatio: number } = { minRetainedRatio: 0.5 },
  ) {}

  async refresh(source: ListSource): Promise<IngestionResult> {
    const fetched = await source.fetchList();
    const entries = dedupe(fetched.entries);
    if (entries.length === 0) throw new Error(`${source.name} : liste vide`);

    const existing = await this.pool.query<{ id: string; is_current: boolean; entry_count: number; version: string }>(
      "SELECT id::text, is_current, entry_count, version FROM aml.list_versions WHERE source = $1 AND content_sha256 = $2",
      [source.name, fetched.contentSha256],
    );
    const known = existing.rows[0];
    if (known?.is_current === true) return { source: source.name, status: "unchanged", version: known.version, entryCount: known.entry_count };

    const current = await this.pool.query<{ entry_count: number }>("SELECT entry_count FROM aml.list_versions WHERE source = $1 AND is_current", [source.name]);
    const previousCount = current.rows[0]?.entry_count;
    if (previousCount !== undefined && entries.length < previousCount * this.options.minRetainedRatio) {
      await this.pool.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('aml_list', gen_random_uuid(), 'aml.list_rejected', $1::jsonb, $2)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [JSON.stringify({ source: source.name, received: entries.length, previous: previousCount }), `aml-list-rejected:${source.name}:${fetched.contentSha256.toString("hex")}`],
      );
      throw new Error(`${source.name} : ${entries.length.toString()} entrées contre ${previousCount.toString()} auparavant, import refusé`);
    }

    await withTransaction(this.pool, { actor: { type: "system", id: "aml-lists" } }, async (client) => {
      let versionId: string;
      if (known !== undefined) {
        versionId = known.id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO aml.list_versions (source, kind, version, content_sha256, entry_count)
           VALUES ($1, $2::aml.list_kind, $3, $4, $5) RETURNING id::text`,
          [source.name, source.kind, fetched.version, fetched.contentSha256, entries.length],
        );
        versionId = inserted.rows[0]?.id ?? "";
        for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
          const batch = entries.slice(offset, offset + BATCH_SIZE);
          const created = await client.query<{ id: string; external_id: string }>(
            `INSERT INTO aml.list_entries (list_version_id, external_id, entry_type, primary_name, birth_dates, countries, programs)
             SELECT $1::bigint, x.external_id, x.entry_type::aml.entry_type, x.primary_name,
                    ARRAY(SELECT jsonb_array_elements_text(x.birth_dates)),
                    ARRAY(SELECT jsonb_array_elements_text(x.countries)),
                    ARRAY(SELECT jsonb_array_elements_text(x.programs))
               FROM jsonb_to_recordset($2::jsonb) AS x(external_id text, entry_type text, primary_name text,
                                                        birth_dates jsonb, countries jsonb, programs jsonb)
             RETURNING id::text, external_id`,
            [
              versionId,
              JSON.stringify(
                batch.map((entry) => ({
                  external_id: entry.externalId,
                  entry_type: entry.entryType,
                  primary_name: entry.primaryName.slice(0, 500),
                  birth_dates: entry.birthDates.slice(0, 20),
                  countries: entry.countries.slice(0, 20),
                  programs: entry.programs.slice(0, 20),
                })),
              ),
            ],
          );
          const ids = new Map(created.rows.map((row) => [row.external_id, row.id]));
          const names: { entry_id: string; name: string; normalized: string }[] = [];
          for (const entry of batch) {
            const entryId = ids.get(entry.externalId);
            if (entryId === undefined) continue;
            const seen = new Set<string>();
            for (const name of [entry.primaryName, ...entry.aliases]) {
              const normalized = normalizeForScreening(name).slice(0, 500);
              if (normalized.length === 0 || seen.has(normalized)) continue;
              seen.add(normalized);
              names.push({ entry_id: entryId, name: name.slice(0, 500), normalized });
            }
          }
          if (names.length > 0) {
            await client.query(
              `INSERT INTO aml.list_entry_names (entry_id, list_version_id, name, normalized)
               SELECT x.entry_id::bigint, $1::bigint, x.name, x.normalized
                 FROM jsonb_to_recordset($2::jsonb) AS x(entry_id text, name text, normalized text)`,
              [versionId, JSON.stringify(names)],
            );
          }
        }
      }
      await client.query("UPDATE aml.list_versions SET is_current = false WHERE source = $1 AND is_current", [source.name]);
      await client.query("UPDATE aml.list_versions SET is_current = true WHERE id = $1::bigint", [versionId]);
      await client.query(
        `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
         VALUES ('aml_list', gen_random_uuid(), 'aml.list_updated', $1::jsonb, $2)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [JSON.stringify({ source: source.name, version: fetched.version, entries: entries.length }), `aml-list-updated:${source.name}:${fetched.contentSha256.toString("hex")}`],
      );
    });
    this.logger.info({ source: source.name, version: fetched.version, entries: entries.length }, "liste de criblage mise à jour");
    return { source: source.name, status: "updated", version: fetched.version, entryCount: entries.length };
  }
}

function dedupe(entries: readonly ListEntry[]): ListEntry[] {
  const seen = new Set<string>();
  const unique: ListEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.externalId)) continue;
    seen.add(entry.externalId);
    unique.push(entry);
  }
  return unique;
}
