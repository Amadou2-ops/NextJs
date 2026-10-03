import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { RETRYABLE_SQLSTATES, sqlStateOf } from "../lib/errors.js";
import type { DatabasePool } from "./pool.js";

/**
 * Exécution transactionnelle.
 *
 * - Chaque transaction déclare son acteur (client, personnel, système,
 *   prestataire) dans les variables de transaction lues par les triggers
 *   d'historisation de la base (app.actor_type / app.actor_id /
 *   app.change_note).
 * - Les conflits de sérialisation (40001) et interblocages (40P01) sont
 *   rejoués automatiquement avec un délai aléatoire croissant ; le corps de la
 *   transaction doit donc être idempotent vis-à-vis de la base (il l'est par
 *   construction : tout est annulé avant la nouvelle tentative).
 * - Aucun effet externe (appel prestataire, e-mail) ne doit être déclenché
 *   dans le corps : il passe par l'outbox (integrations.outbox).
 */

export type ActorType = "customer" | "admin" | "system" | "provider";

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  readonly actor: Actor;
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  readonly changeNote?: string;
  readonly maxAttempts?: number;
}

export interface Queryable {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

/** Client restreint exposé au corps de la transaction (pas de COMMIT manuel). */
export interface TransactionClient extends Queryable {
  readonly attempt: number;
}

const ISOLATION_SQL: Readonly<Record<IsolationLevel, string>> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

const ACTOR_ID_PATTERN = /^[A-Za-z0-9:_.@-]{1,200}$/;

export class TransactionError extends Error {
  override readonly name = "TransactionError";
}

export async function withTransaction<T>(
  pool: DatabasePool,
  options: TransactionOptions,
  body: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!ACTOR_ID_PATTERN.test(options.actor.id)) {
    throw new TransactionError("identifiant d'acteur invalide pour la transaction");
  }
  if (options.changeNote !== undefined && options.changeNote.length > 1000) {
    throw new TransactionError("note de changement trop longue (1000 caractères maximum)");
  }
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TransactionError("maxAttempts doit être compris entre 1 et 10");
  }
  const isolation = ISOLATION_SQL[options.isolation ?? "read committed"];
  const access = options.readOnly === true ? "READ ONLY" : "READ WRITE";

  for (let attempt = 1; ; attempt += 1) {
    const connection = await pool.connect();
    let brokenConnection: Error | undefined;
    try {
      await connection.query(`BEGIN ISOLATION LEVEL ${isolation} ${access}`);
      await connection.query(
        `SELECT set_config('app.actor_type', $1, true),
                set_config('app.actor_id', $2, true),
                set_config('app.change_note', $3, true)`,
        [options.actor.type, options.actor.id, options.changeNote ?? ""],
      );
      const client: TransactionClient = {
        attempt,
        query: (text, values) => connection.query(text, values === undefined ? undefined : [...values]),
      };
      const result = await body(client);
      await connection.query("COMMIT");
      return result;
    } catch (error: unknown) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError: unknown) {
        // Connexion inutilisable : elle sera détruite au lieu d'être rendue au pool.
        brokenConnection = rollbackError instanceof Error ? rollbackError : new Error("échec du ROLLBACK");
      }
      const sqlState = sqlStateOf(error);
      const retryable = sqlState !== undefined && RETRYABLE_SQLSTATES.has(sqlState) && attempt < maxAttempts;
      if (!retryable) throw error;
    } finally {
      connection.release(brokenConnection);
    }
    // Atteint uniquement après un conflit rejouable : nouvelle tentative.
    await sleep(backoffDelayMs(attempt));
  }
}

/** Délai exponentiel plafonné avec gigue complète : 0..(25 ms × 2^n), ≤ 400 ms. */
export function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(400, 25 * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}
