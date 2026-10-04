import { createHash } from "node:crypto";

import type { DatabasePool } from "../db/pool.js";

/**
 * Idempotence des requêtes HTTP mutatrices (en-tête Idempotency-Key).
 *
 * Garanties :
 *   - même clé + même requête déjà terminée → la réponse d'origine est
 *     renvoyée telle quelle, sans réexécution ;
 *   - même clé + requête différente → 422 IDEMPOTENCY_CONFLICT ;
 *   - même clé pendant que la première requête est en cours → 409
 *     REQUEST_IN_PROGRESS ;
 *   - une requête interrompue (crash, erreur 5xx) libère sa clé, qui peut
 *     être reprise après expiration du verrou.
 *
 * Défense en profondeur : les opérations financières sont AUSSI idempotentes
 * en base (clés d'idempotence du registre, unicité (user_id, idempotency_key)
 * des transferts). Si le processus tombe entre la validation métier et
 * l'enregistrement de la réponse, la reprise ne peut donc jamais produire un
 * second débit.
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const LOCK_SECONDS = 60;

export type IdempotencyBeginResult =
  | { readonly kind: "started" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "mismatch" }
  | { readonly kind: "in_progress" };

export interface IdempotencyStore {
  begin(scope: string, key: string, requestHash: Buffer): Promise<IdempotencyBeginResult>;
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  release(scope: string, key: string): Promise<void>;
}

/** Poignée attachée à res.locals pendant le traitement d'une requête idempotente. */
export interface IdempotencyHandle {
  finalize(status: number, body: unknown): Promise<void>;
}

/** Sérialisation JSON canonique (clés triées récursivement). */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): Buffer {
  return createHash("sha256")
    .update(method.toUpperCase(), "utf8")
    .update("\n", "utf8")
    .update(path, "utf8")
    .update("\n", "utf8")
    .update(canonicalJson(body ?? null), "utf8")
    .digest();
}

interface IdempotencyRow {
  request_sha256: Buffer;
  response_status: number | null;
  response_body: unknown;
  locked: boolean;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: DatabasePool) {}

  async begin(scope: string, key: string, requestHash: Buffer): Promise<IdempotencyBeginResult> {
    const inserted = await this.pool.query(
      `INSERT INTO integrations.http_idempotency_keys (scope, idempotency_key, request_sha256, locked_until)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING 1`,
      [scope, key, requestHash, LOCK_SECONDS],
    );
    if (inserted.rowCount === 1) return { kind: "started" };

    const existing = await this.pool.query<IdempotencyRow>(
      `SELECT request_sha256, response_status, response_body,
              (locked_until IS NOT NULL AND locked_until > now()) AS locked
         FROM integrations.http_idempotency_keys
        WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      // Purge concurrente de la clé expirée : on retente l'insertion une fois.
      return this.begin(scope, key, requestHash);
    }
    if (!row.request_sha256.equals(requestHash)) return { kind: "mismatch" };
    if (row.response_status !== null) return { kind: "replay", status: row.response_status, body: row.response_body };
    if (row.locked) return { kind: "in_progress" };

    // Tentative précédente interrompue : reprise atomique du verrou.
    const takeover = await this.pool.query(
      `UPDATE integrations.http_idempotency_keys
          SET locked_until = now() + make_interval(secs => $3)
        WHERE scope = $1 AND idempotency_key = $2
          AND completed_at IS NULL
          AND (locked_until IS NULL OR locked_until <= now())
        RETURNING 1`,
      [scope, key, LOCK_SECONDS],
    );
    return takeover.rowCount === 1 ? { kind: "started" } : { kind: "in_progress" };
  }

  async complete(scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE integrations.http_idempotency_keys
          SET response_status = $3, response_body = $4::jsonb, completed_at = now(), locked_until = NULL
        WHERE scope = $1 AND idempotency_key = $2 AND completed_at IS NULL`,
      [scope, key, status, canonicalJson(body ?? null)],
    );
  }

  async release(scope: string, key: string): Promise<void> {
    await this.pool.query(
      `UPDATE integrations.http_idempotency_keys
          SET locked_until = NULL
        WHERE scope = $1 AND idempotency_key = $2 AND completed_at IS NULL`,
      [scope, key],
    );
  }
}
