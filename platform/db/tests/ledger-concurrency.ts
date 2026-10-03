import pg from "pg";

import type { DatabaseConfig } from "../src/config.js";
import { describeError } from "../src/migrator.js";
import type { TestOutcome } from "../src/test-runner.js";

/**
 * Tests de concurrence du registre, sur de vraies transactions validées et
 * des connexions parallèles, exécutées sous le rôle applicatif app_api :
 *
 *   1. Double dépense : 100 débits simultanés de 15,00 EUR sur un solde de
 *      1 000,00 EUR → exactement 66 réussissent, 34 échouent en LG001, le
 *      solde final vaut 10,00 EUR et n'est jamais négatif.
 *   2. Idempotence concurrente : 30 requêtes simultanées avec la même clé
 *      → un seul journal, un seul débit.
 *   3. Absence d'interblocage : 200 virements croisés A→B / B→A simultanés
 *      → aucune erreur 40P01, la somme des deux soldes est conservée.
 */

const POOL_SIZE = 20;

interface Accounts {
  readonly walletA: string;
  readonly walletB: string;
  readonly settlement: string;
  readonly fees: string;
}

function line(accountId: string, direction: "debit" | "credit", amount: number, currency: string): Record<string, unknown> {
  return { account_id: accountId, direction, amount, currency };
}

function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function setup(admin: pg.Client, suffix: string): Promise<Accounts> {
  await admin.query("BEGIN");
  try {
    await admin.query("UPDATE ref.currencies SET is_enabled = true WHERE code = 'EUR'");
    const users = await admin.query<{ id: string }>(
      `INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                   pii_key_id, status, phone_verified_at)
       VALUES (sha256(convert_to($1, 'UTF8')), '\\x01', 'FR', '$argon2id$v=19$concurrency', 'FR', 'kms-key-v1', 'active', now()),
              (sha256(convert_to($2, 'UTF8')), '\\x02', 'FR', '$argon2id$v=19$concurrency', 'FR', 'kms-key-v1', 'active', now())
       RETURNING id`,
      [`concurrency-a-${suffix}`, `concurrency-b-${suffix}`],
    );
    const [userA, userB] = users.rows;
    if (userA === undefined || userB === undefined) throw new Error("création des clients de test impossible");

    const accounts = await admin.query<{ wallet_a: string; wallet_b: string; settlement: string; fees: string }>(
      `SELECT ledger.open_customer_account($1, 'customer_wallet', 'EUR') AS wallet_a,
              ledger.open_customer_account($2, 'customer_wallet', 'EUR') AS wallet_b,
              ledger.open_system_account('provider_settlement', 'EUR', 'stripe') AS settlement,
              ledger.open_system_account('fee_revenue', 'EUR') AS fees`,
      [userA.id, userB.id],
    );
    const row = accounts.rows[0];
    if (row === undefined) throw new Error("ouverture des comptes de test impossible");

    for (const [wallet, key] of [[row.wallet_a, "a"], [row.wallet_b, "b"]] as const) {
      await admin.query(
        `SELECT ledger.post_journal($1, 'wallet_funding', $2::jsonb, 'Approvisionnement test de concurrence', 'test')`,
        [
          `concurrency:${suffix}:funding:${key}`,
          JSON.stringify([line(row.settlement, "debit", 100_000, "EUR"), line(wallet, "credit", 100_000, "EUR")]),
        ],
      );
    }
    await admin.query("COMMIT");
    return { walletA: row.wallet_a, walletB: row.wallet_b, settlement: row.settlement, fees: row.fees };
  } catch (error: unknown) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function balanceOf(pool: pg.Pool, accountId: string): Promise<number> {
  const result = await pool.query<{ balance: string }>(
    "SELECT balance::text FROM ledger.account_balances WHERE account_id = $1",
    [accountId],
  );
  const value = result.rows[0]?.balance;
  if (value === undefined) throw new Error(`solde introuvable pour ${accountId}`);
  return Number(value);
}

async function postAsApi(
  pool: pg.Pool,
  key: string,
  entries: readonly Record<string, unknown>[],
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT ledger.post_journal($1, 'transfer_fee', $2::jsonb, 'Débit concurrent', 'test:concurrency') AS id`,
    [key, JSON.stringify(entries)],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("post_journal n'a renvoyé aucun identifiant");
  return id;
}

async function timed(name: string, body: () => Promise<void>): Promise<TestOutcome> {
  const startedAt = performance.now();
  try {
    await body();
    return { name, passed: true, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error: unknown) {
    return { name, passed: false, durationMs: Math.round(performance.now() - startedAt), error: describeError(error) };
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export async function runLedgerConcurrencySuite(
  connectionString: string,
  ssl: DatabaseConfig["ssl"],
): Promise<readonly TestOutcome[]> {
  const suffix = `${Date.now()}`;
  const admin = new pg.Client({ connectionString, ssl });
  await admin.connect();
  let accounts: Accounts;
  try {
    accounts = await setup(admin, suffix);
  } finally {
    await admin.end();
  }

  // Chaque connexion agit sous le rôle applicatif, sans privilège d'écriture.
  const pool = new pg.Pool({ connectionString, ssl, max: POOL_SIZE, options: "-c role=app_api" });

  try {
    const outcomes: TestOutcome[] = [];

    outcomes.push(
      await timed("concurrency/double-spend", async () => {
        const attempts = Array.from({ length: 100 }, (_, index) =>
          postAsApi(pool, `concurrency:${suffix}:spend:${index}`, [
            line(accounts.walletA, "debit", 1_500, "EUR"),
            line(accounts.fees, "credit", 1_500, "EUR"),
          ]),
        );
        const results = await Promise.allSettled(attempts);
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        const insufficient = results.filter((r) => r.status === "rejected" && sqlState(r.reason) === "LG001").length;
        const otherErrors = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected" && sqlState(r.reason) !== "LG001")
          .map((r) => describeError(r.reason));
        expect(otherErrors.length === 0, `erreurs inattendues : ${otherErrors.slice(0, 3).join(" | ")}`);
        expect(succeeded === 66, `66 débits attendus, ${succeeded} obtenus`);
        expect(insufficient === 34, `34 refus LG001 attendus, ${insufficient} obtenus`);
        const balance = await balanceOf(pool, accounts.walletA);
        expect(balance === 1_000, `solde final 1 000 attendu, ${balance} obtenu`);
      }),
    );

    outcomes.push(
      await timed("concurrency/idempotent-retries", async () => {
        const before = await balanceOf(pool, accounts.walletB);
        const key = `concurrency:${suffix}:idempotent`;
        const results = await Promise.allSettled(
          Array.from({ length: 30 }, () =>
            postAsApi(pool, key, [line(accounts.walletB, "debit", 2_500, "EUR"), line(accounts.fees, "credit", 2_500, "EUR")]),
          ),
        );
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(rejected.length === 0, `rejeux en erreur : ${rejected.map((r) => describeError(r.reason)).slice(0, 3).join(" | ")}`);
        const ids = new Set(results.map((r) => (r.status === "fulfilled" ? r.value : "")));
        expect(ids.size === 1, `un seul journal attendu, ${ids.size} identifiants distincts`);
        const after = await balanceOf(pool, accounts.walletB);
        expect(before - after === 2_500, `un seul débit de 2 500 attendu, écart ${before - after}`);
      }),
    );

    outcomes.push(
      await timed("concurrency/no-deadlock-crossed-transfers", async () => {
        const before = (await balanceOf(pool, accounts.walletA)) + (await balanceOf(pool, accounts.walletB));
        const results = await Promise.allSettled(
          Array.from({ length: 200 }, (_, index) => {
            const [from, to] = index % 2 === 0 ? [accounts.walletA, accounts.walletB] : [accounts.walletB, accounts.walletA];
            return postAsApi(pool, `concurrency:${suffix}:cross:${index}`, [line(from, "debit", 1, "EUR"), line(to, "credit", 1, "EUR")]);
          }),
        );
        const deadlocks = results.filter((r) => r.status === "rejected" && sqlState(r.reason) === "40P01").length;
        const unexpected = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected" && sqlState(r.reason) !== "LG001")
          .map((r) => describeError(r.reason));
        expect(deadlocks === 0, `${deadlocks} interblocage(s) détecté(s)`);
        expect(unexpected.length === 0, `erreurs inattendues : ${unexpected.slice(0, 3).join(" | ")}`);
        const after = (await balanceOf(pool, accounts.walletA)) + (await balanceOf(pool, accounts.walletB));
        expect(before === after, `somme des soldes non conservée : ${before} → ${after}`);
      }),
    );

    return outcomes;
  } finally {
    await pool.end();
  }
}
