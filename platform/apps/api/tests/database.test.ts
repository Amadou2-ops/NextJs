import { afterAll, describe, expect, it } from "vitest";

import { withTransaction } from "../src/db/transaction.js";
import { toAppError } from "../src/lib/errors.js";
import { applyMarginToRate, convertMinor } from "../src/lib/money.js";
import { buildTestConfig, createApiPool, createOwnerPool, createTestKeys, seedCustomer } from "./support/fixtures.js";

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const apiPool = createApiPool(config);
const owner = createOwnerPool();

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("pool PostgreSQL", () => {
  it("se connecte sous le rôle applicatif et convertit int8 en BigInt", async () => {
    const result = await apiPool.query<{ role: string; big: bigint; rate: string }>(
      "SELECT current_user AS role, 9007199254740993::bigint AS big, 655.957000000000000::numeric AS rate",
    );
    expect(result.rows[0]).toEqual({ role: "app_api", big: 9007199254740993n, rate: "655.957000000000000" });
  });
});

describe("withTransaction", () => {
  it("déclare l'acteur de la transaction aux triggers d'historisation", async () => {
    const values = await withTransaction(apiPool, { actor: { type: "admin", id: "admin:42" }, changeNote: "revue KYC" }, async (tx) => {
      const result = await tx.query<{ type: string; id: string; note: string }>(
        "SELECT current_setting('app.actor_type') AS type, current_setting('app.actor_id') AS id, current_setting('app.change_note') AS note",
      );
      return result.rows[0];
    });
    expect(values).toEqual({ type: "admin", id: "admin:42", note: "revue KYC" });
    // Variables locales : aucune fuite vers la connexion suivante du pool.
    const after = await apiPool.query<{ type: string | null }>("SELECT current_setting('app.actor_type', true) AS type");
    expect(after.rows[0]?.type ?? "").toBe("");
  });

  it("annule tout en cas d'erreur", async () => {
    const customer = await seedCustomer(owner);
    await expect(
      withTransaction(apiPool, { actor: { type: "customer", id: customer.userId } }, async (tx) => {
        await tx.query("SELECT ledger.open_customer_account($1, 'customer_wallet', 'EUR')", [customer.userId]);
        throw new Error("échec métier");
      }),
    ).rejects.toThrow("échec métier");
    const accounts = await owner.query("SELECT 1 FROM ledger.accounts WHERE owner_user_id = $1", [customer.userId]);
    expect(accounts.rowCount).toBe(0);
  });

  it("rejoue automatiquement un conflit de sérialisation", async () => {
    let attempts = 0;
    const result = await withTransaction(apiPool, { actor: { type: "system", id: "test" }, maxAttempts: 3 }, (tx) => {
      attempts = tx.attempt;
      if (tx.attempt === 1) return Promise.reject(Object.assign(new Error("could not serialize access"), { code: "40001" }));
      return Promise.resolve("ok");
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("ne rejoue jamais une erreur métier", async () => {
    let attempts = 0;
    await expect(
      withTransaction(apiPool, { actor: { type: "system", id: "test" } }, (tx) => {
        attempts = tx.attempt;
        return Promise.reject(Object.assign(new Error("provision insuffisante"), { code: "LG001" }));
      }),
    ).rejects.toMatchObject({ code: "LG001" });
    expect(attempts).toBe(1);
  });

  it("traduit une provision insuffisante du registre en INSUFFICIENT_FUNDS", async () => {
    const customer = await seedCustomer(owner);
    const error = await withTransaction(apiPool, { actor: { type: "customer", id: customer.userId } }, async (tx) => {
      const wallet = await tx.query<{ id: string }>("SELECT ledger.open_customer_account($1, 'customer_wallet', 'EUR') AS id", [customer.userId]);
      const fees = await tx.query<{ id: string }>("SELECT ledger.open_system_account('fee_revenue', 'EUR') AS id");
      await tx.query(
        "SELECT ledger.post_journal($1, 'transfer_fee', $2::jsonb, 'Frais', 'test')",
        [
          `test:${customer.userId}:fee`,
          JSON.stringify([
            { account_id: wallet.rows[0]?.id, direction: "debit", amount: 100, currency: "EUR" },
            { account_id: fees.rows[0]?.id, direction: "credit", amount: 100, currency: "EUR" },
          ]),
        ],
      );
    }).catch((caught: unknown) => toAppError(caught));
    expect(error).toMatchObject({ code: "INSUFFICIENT_FUNDS", httpStatus: 422 });
  });
});

describe("parité des calculs monétaires API ↔ base", () => {
  const cases: readonly [bigint, string, string, string][] = [
    [10000n, "646.117645", "EUR", "XOF"],
    [64611n, "0.001524490172404", "XOF", "EUR"],
    [1n, "0.000000000000001", "EUR", "USD"],
    [999_999_999_999n, "151.123456789012345", "USD", "JPY"],
    [12345n, "0.376", "BHD", "USD"],
    [5000n, "1.084729", "GBP", "EUR"],
  ];

  it.each(cases)("convertMinor(%s, %s, %s → %s) = fx.convert_minor", async (amount, rate, from, to) => {
    const units = await owner.query<{ code: string; minor_units: number }>(
      "SELECT code, minor_units FROM ref.currencies WHERE code = ANY($1)",
      [[from, to]],
    );
    const unitsOf = (code: string): number => units.rows.find((row) => row.code === code)!.minor_units;
    const sql = await owner.query<{ value: string }>("SELECT fx.convert_minor($1::bigint, $2::numeric, $3, $4)::text AS value", [
      amount.toString(), rate, from, to,
    ]);
    expect(convertMinor(amount, rate, unitsOf(from), unitsOf(to)).toString()).toBe(sql.rows[0]?.value);
  });

  it.each([
    ["655.957", 150],
    ["1.084729", 75],
    ["0.000123456789", 1500],
    ["151.123456789012345", 33],
  ] as const)("applyMarginToRate(%s, %i) = round(mid × (10000 − marge) / 10000, 15)", async (mid, margin) => {
    const sql = await owner.query<{ value: string }>(
      "SELECT trim(trailing '.' FROM trim(trailing '0' FROM round($1::numeric * (10000 - $2)::numeric / 10000, 15)::text)) AS value",
      [mid, margin],
    );
    expect(applyMarginToRate(mid, margin)).toBe(sql.rows[0]?.value);
  });
});
