import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPaymentHarness } from "./support/paymentHarness.js";

/**
 * Concurrence de bout en bout (HTTP → service → PostgreSQL) : des requêtes
 * simultanées ne doivent jamais dépenser deux fois le même solde ni créer
 * deux transferts pour une même clé d'idempotence.
 */

const harness = await createPaymentHarness();
const { owner, verifiedCustomer, totp, addRecipient, quote, createTransfer, balance } = harness;

beforeAll(harness.setup);
beforeEach(harness.resetEach);
afterAll(harness.teardown);

async function transfersOf(userId: string): Promise<number> {
  const result = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM transfers.transfers WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.count ?? "0");
}

describe("concurrence HTTP", () => {
  it("ne dépense jamais deux fois le même solde", async () => {
    // 150,00 EUR : un seul transfert de 101,99 EUR peut passer.
    const customer = await verifiedCustomer({ walletEur: 15_000n });
    const recipientId = await addRecipient(customer, "+221770008888");
    const [firstQuote, secondQuote] = [await quote(customer, "wallet_balance"), await quote(customer, "wallet_balance")];
    const [firstCode, secondCode] = [totp(customer), totp(customer)];

    const responses = await Promise.all([
      createTransfer(customer, { quoteId: firstQuote, recipientId, purposeCode: "family_support", totpCode: firstCode }),
      createTransfer(customer, { quoteId: secondQuote, recipientId, purposeCode: "family_support", totpCode: secondCode }),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const rejected of responses.filter((response) => response.status !== 201)) {
      expect([403, 409, 422]).toContain(rejected.status);
    }
    expect(await transfersOf(customer.userId)).toBe(1);
    expect(await balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(15_000n - 10_199n);
  });

  it("ne crée qu'un transfert pour une même clé d'idempotence, même en rafale", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221770009999");
    const body = { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) };
    const key = `burst-${randomUUID()}`;

    const responses = await Promise.all(Array.from({ length: 5 }, () => createTransfer(customer, body, key)));
    const created = responses.filter((response) => response.status === 201);
    expect(created).toHaveLength(1);
    for (const other of responses.filter((response) => response.status !== 201)) {
      // Rejeu de la réponse enregistrée ou requête identique encore en cours.
      if (other.status === 200) expect(other.body.transfer.id).toBe(created[0]?.body.transfer.id);
      else expect(other.body.code).toBe("REQUEST_IN_PROGRESS");
    }
    expect(await transfersOf(customer.userId)).toBe(1);
    expect(await balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(50_000n - 10_199n);
  });

  it("consomme chaque devis une seule fois", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221770006666");
    const quoteId = await quote(customer, "wallet_balance");
    const [firstCode, secondCode] = [totp(customer), totp(customer)];
    const responses = await Promise.all([
      createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: firstCode }),
      createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: secondCode }),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await transfersOf(customer.userId)).toBe(1);
  });
});
