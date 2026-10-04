import { randomBytes, randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fieldContext } from "../src/lib/crypto/fieldEncryption.js";
import { DecimalLiteral, stringifyWithDecimals } from "../src/lib/json.js";
import { decimalStringToMinor, decimalStringToMinorCeil, minorToDecimalString } from "../src/lib/money.js";
import { CircuitBreaker } from "../src/modules/payments/circuitBreaker.js";
import { encodeStripeForm } from "../src/modules/payments/providers/stripe.client.js";
import { PaymentProviderError } from "../src/modules/payments/providers/types.js";
import { normalizeIban } from "../src/modules/recipients/recipients.service.js";
import { TestDevice } from "./support/device.js";
import { STRIPE_PUBLISHABLE, STRIPE_WEBHOOK_SECRET } from "./support/fakePayments.js";
import { signAccessToken } from "./support/fixtures.js";
import { createPaymentHarness } from "./support/paymentHarness.js";

// =============================================================================
// Tests unitaires
// =============================================================================

describe("primitives de paiement", () => {
  it("convertit exactement unités mineures et décimaux prestataires", () => {
    expect(minorToDecimalString(10199n, 2)).toBe("101.99");
    expect(minorToDecimalString(5n, 2)).toBe("0.05");
    expect(minorToDecimalString(64611n, 0)).toBe("64611");
    expect(minorToDecimalString(12345n, 3)).toBe("12.345");
    expect(decimalStringToMinor("101.99", 2)).toBe(10199n);
    expect(decimalStringToMinor("101.9", 2)).toBe(10190n);
    expect(decimalStringToMinor("64611", 0)).toBe(64611n);
    expect(() => decimalStringToMinor("101.995", 2)).toThrow();
    expect(() => decimalStringToMinor("-1", 2)).toThrow();
    expect(decimalStringToMinorCeil("26.875", 2)).toBe(2688n);
    expect(decimalStringToMinorCeil("26.870", 2)).toBe(2687n);
  });

  it("émet les montants JSON depuis leur texte exact et encode le format Stripe", () => {
    expect(stringifyWithDecimals({ amount: new DecimalLiteral("101.99"), nested: [new DecimalLiteral("0.000000000000001")], label: "x" })).toBe(
      '{"amount":101.99,"nested":[0.000000000000001],"label":"x"}',
    );
    expect(() => new DecimalLiteral("1e5")).toThrow();
    expect(encodeStripeForm({ amount: 10199n, currency: "eur", payment_method_types: ["card"], metadata: { transfer_id: "t1" } })).toBe(
      "amount=10199&currency=eur&payment_method_types%5B0%5D=card&metadata%5Btransfer_id%5D=t1",
    );
  });

  it("valide les IBAN (clé ISO 13616)", () => {
    expect(normalizeIban("fr76 3000 6000 0112 3456 7890 189")).toBe("FR7630006000011234567890189");
    expect(() => normalizeIban("FR7630006000011234567890188")).toThrow();
    expect(() => normalizeIban("XX12")).toThrow();
  });
});


// =============================================================================
// Parcours complets
// =============================================================================

const harness = await createPaymentHarness();
const { keys, owner, apiPool, fake, encryptor, orchestrator, app, verifiedCustomer, totp, addRecipient, quote, createTransfer, transferStatus, balance, journals, payoutAttempts, postFlutterwave, postStripe, postThunes, age } = harness;

beforeAll(harness.setup);
beforeEach(harness.resetEach);
afterAll(harness.teardown);

describe("bénéficiaires", () => {
  it("enregistre des coordonnées chiffrées et indexées, refuse doublons et numéros étrangers", async () => {
    const customer = await verifiedCustomer();
    const id = await addRecipient(customer);
    const stored = await owner.query<{ account_details_enc: Buffer; full_name_enc: Buffer; display_hint: string; mobile_operator: string }>(
      "SELECT account_details_enc, full_name_enc, display_hint, mobile_operator FROM transfers.recipients WHERE id = $1",
      [id],
    );
    const row = stored.rows[0]!;
    expect(row.account_details_enc.includes(Buffer.from("221771234567"))).toBe(false);
    expect(row.display_hint).toBe("•••• 4567 · Orange Money");
    expect(JSON.parse(await encryptor.decrypt(row.account_details_enc, fieldContext("transfers", "recipients", "account_details", id)))).toEqual({
      kind: "mobile_money",
      msisdn: "+221771234567",
      operator: "orange_money",
    });

    const duplicate = await request(app)
      .post("/v1/recipients")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ country: "SN", currency: "XOF", firstName: "Moussa", lastName: "Ndiaye", account: { kind: "mobile_money", msisdn: "77 123 45 67", operator: "orange_money" } });
    expect(duplicate.status).toBe(409);
    const foreign = await request(app)
      .post("/v1/recipients")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ country: "SN", currency: "XOF", firstName: "Moussa", lastName: "Ndiaye", account: { kind: "mobile_money", msisdn: "+33612345678", operator: "wave" } });
    expect(foreign.status).toBe(400);
    const closed = await request(app)
      .post("/v1/recipients")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ country: "KP", currency: "KPW", firstName: "A", lastName: "B", account: { kind: "cash_pickup", msisdn: "+850191234567" } });
    expect(closed.status).toBe(400);
    const badIban = await request(app)
      .post("/v1/recipients")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ country: "SN", currency: "XOF", firstName: "Awa", lastName: "Sow", account: { kind: "bank_account", iban: "SN08SN0100152000048500003035", accountNumber: "1" } });
    expect(badIban.status).toBe(400);

    const list = await request(app).get("/v1/recipients").set("Authorization", `Bearer ${customer.token}`);
    expect(list.body.recipients).toEqual([expect.objectContaining({ id, firstName: "Moussa", lastName: "Ndiaye", payoutMethod: "mobile_money" }) as unknown]);
    const other = await verifiedCustomer({ walletEur: 0n });
    expect((await request(app).delete(`/v1/recipients/${id}`).set("Authorization", `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).delete(`/v1/recipients/${id}`).set("Authorization", `Bearer ${customer.token}`)).status).toBe(204);
    expect((await request(app).get("/v1/recipients").set("Authorization", `Bearer ${customer.token}`)).body.recipients).toEqual([]);
  });
});

describe("transfert financé par le portefeuille", () => {
  it("réserve, paie via Flutterwave, règle à la confirmation et comptabilise chaque étape", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer);
    const quoteId = await quote(customer, "wallet_balance");
    const settlementBefore = await balance({ type: "provider_settlement", currency: "XOF", provider: "flutterwave" });
    // Comptes système partagés entre fichiers de test : assertions relatives.
    const clearingBefore = await balance({ type: "payout_clearing", currency: "XOF", provider: "flutterwave" });
    const feeBefore = await balance({ type: "fee_revenue", currency: "EUR" });

    const key = `idem-${randomUUID()}`;
    const response = await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: totp(customer) }, key);
    expect(response.status).toBe(201);
    expect(response.body.funding).toBeNull();
    const transfer = response.body.transfer as { id: string; reference: string; status: string; totalToPay: unknown; receiveAmount: unknown };
    expect(transfer).toMatchObject({ status: "payout_processing", totalToPay: { amount: "10199", currency: "EUR" }, receiveAmount: { amount: "64611", currency: "XOF" } });

    // Ordre Flutterwave : montant exact, opérateur du corridor, numéro sans « + ».
    const order = [...fake.flwTransfers.values()].find((entry) => entry.reference.startsWith("po-") && entry.account_number === "221771234567");
    expect(order).toMatchObject({ amount: "64611", currency: "XOF", account_bank: "FMM" });
    expect(fake.calls.find((call) => call.url.endsWith("/v3/transfers") && call.body.includes(order!.reference))?.body).toContain('"amount":64611');

    // Réservation puis paiement : le portefeuille est débité, la réservation transférée au paiement sortant.
    expect(await balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(50000n - 10199n);
    expect(await balance({ type: "customer_hold", currency: "EUR", userId: customer.userId })).toBe(0n);
    expect(await balance({ type: "fee_revenue", currency: "EUR" })).toBe(feeBefore + 199n);

    // Rejeu : même transfert, aucun nouvel ordre.
    const replay = await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: "000000" }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body.transfer.id).toBe(transfer.id);
    const otherQuote = await quote(customer, "wallet_balance");
    expect((await createTransfer(customer, { quoteId: otherQuote, recipientId, purposeCode: "family_support", totpCode: totp(customer) }, key)).status).toBe(422);

    // Confirmation Flutterwave (webhook = signal, état relu par l'API).
    order!.status = "SUCCESSFUL";
    expect((await postFlutterwave({ event: "transfer.completed", data: { id: order!.id, reference: order!.reference, status: "SUCCESSFUL" } }, "mauvais-secret-0000")).status).toBe(401);
    expect((await postFlutterwave({ event: "transfer.completed", data: { id: order!.id, reference: order!.reference, status: "SUCCESSFUL" } })).status).toBe(200);
    expect(await transferStatus(transfer.id)).toBe("completed");
    expect(await balance({ type: "payout_clearing", currency: "XOF", provider: "flutterwave" })).toBe(clearingBefore);
    expect(await balance({ type: "provider_settlement", currency: "XOF", provider: "flutterwave" })).toBe(settlementBefore - 64611n - 500n);
    expect(await journals(transfer.id)).toEqual(["transfer:T:funding", "transfer:T:payout:A", "transfer:T:payout_settlement:A", "transfer:T:payout_fee:A"]);

    const detail = await request(app).get(`/v1/transfers/${transfer.id}`).set("Authorization", `Bearer ${customer.token}`);
    expect((detail.body.history as { status: string }[]).map((entry) => entry.status)).toEqual(["created", "funded", "payout_pending", "payout_processing", "completed"]);
    const list = await request(app).get("/v1/transfers?limit=1").set("Authorization", `Bearer ${customer.token}`);
    expect(list.body.transfers).toHaveLength(1);
    expect(list.body.nextCursor).toBeNull();
    const stranger = await verifiedCustomer({ walletEur: 0n });
    expect((await request(app).get(`/v1/transfers/${transfer.id}`).set("Authorization", `Bearer ${stranger.token}`)).status).toBe(404);
    expect((await request(app).post(`/v1/transfers/${transfer.id}/cancel`).set("Authorization", `Bearer ${customer.token}`)).status).toBe(409);
    const outbox = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_id = $1 ORDER BY id", [transfer.id]);
    expect(outbox.rows.map((row) => row.event_type)).toEqual(["transfers.created", "transfers.funded", "transfers.completed"]);
  });

  it("exige l'autorisation renforcée, le solde, le niveau KYC et la propriété du devis", async () => {
    const customer = await verifiedCustomer({ walletEur: 5000n });
    const recipientId = await addRecipient(customer);
    const quoteId = await quote(customer, "wallet_balance");
    expect((await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support" })).status).toBe(403);
    expect((await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: "123456" })).status).toBe(422);
    expect((await request(app).post("/v1/transfers").set("Authorization", `Bearer ${customer.token}`).send({ quoteId, recipientId, purposeCode: "family_support", totpCode: totp(customer) })).status).toBe(400);

    const insufficient = await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(insufficient.status).toBe(422);
    expect(insufficient.body.code).toBe("INSUFFICIENT_FUNDS");
    expect((await owner.query("SELECT consumed_at FROM fx.quotes WHERE id = $1", [quoteId])).rows[0]?.consumed_at).toBeNull();
    expect((await owner.query("SELECT 1 FROM transfers.transfers WHERE quote_id = $1", [quoteId])).rowCount).toBe(0);

    const unverified = await verifiedCustomer({ tier: "tier_0" });
    const unverifiedRecipient = await addRecipient(unverified);
    const limited = await createTransfer(unverified, { quoteId: await quote(unverified, "wallet_balance"), recipientId: unverifiedRecipient, purposeCode: "family_support", totpCode: totp(unverified) });
    expect(limited.status).toBe(403);
    expect(limited.body.code).toBe("KYC_LIMIT_EXCEEDED");

    const thief = await verifiedCustomer();
    const thiefRecipient = await addRecipient(thief);
    expect((await createTransfer(thief, { quoteId, recipientId: thiefRecipient, purposeCode: "family_support", totpCode: totp(thief) })).status).toBe(404);
  });

  it("accepte une session mobile signée par l'appareil (autorisation device_signature)", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221781112211");
    const device = new TestDevice("ES256");
    const deviceRow = await owner.query<{ id: string }>(
      `INSERT INTO identity.devices (user_id, platform, device_name, public_key_spki, public_key_algorithm, attestation_type,
                                     attestation_verified_at, trusted_at)
       VALUES ($1, 'ios', 'iPhone de test', $2, 'ES256', 'app_attest', now(), now()) RETURNING id`,
      [customer.userId, device.publicKeySpki],
    );
    const deviceId = deviceRow.rows[0]!.id;
    const session = await owner.query<{ id: string }>(
      `INSERT INTO identity.sessions (user_id, device_id, audience, assurance_level, mfa_verified_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, 'mobile', 2, now(), now() + interval '30 minutes', now() + interval '30 days') RETURNING id`,
      [customer.userId, deviceId],
    );
    const mobileToken = await signAccessToken({ key: keys.customer, audience: "mobile", subject: customer.userId, sessionId: session.rows[0]!.id, deviceId, assuranceLevel: 2 });
    const body = { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support" };

    const unsigned = await request(app).post("/v1/transfers").set("Authorization", `Bearer ${mobileToken}`).set("Idempotency-Key", `idem-${randomUUID()}`).send(body);
    expect(unsigned.status).toBe(401);
    const signed = await request(app)
      .post("/v1/transfers")
      .set("Authorization", `Bearer ${mobileToken}`)
      .set("Idempotency-Key", `idem-${randomUUID()}`)
      .set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/transfers", body }))
      .send(body);
    expect(signed.status).toBe(201);
    const stored = await owner.query<{ authorization_method: string; authorized_device_id: string }>(
      "SELECT authorization_method, authorized_device_id FROM transfers.transfers WHERE id = $1",
      [signed.body.transfer.id],
    );
    expect(stored.rows[0]).toEqual({ authorization_method: "device_signature", authorized_device_id: deviceId });
  });

  it("change de route après un refus Flutterwave et termine via Thunes", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221781112233");
    fake.flutterwaveTransfers = "reject";
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "education", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    const transferId = response.body.transfer.id as string;
    expect(response.body.transfer.status).toBe("payout_processing");
    expect(await payoutAttempts(transferId)).toEqual([
      expect.objectContaining({ provider: "flutterwave", status: "failed", failure_code: "rejected" }) as unknown,
      expect.objectContaining({ provider: "thunes", status: "processing" }) as unknown,
    ]);
    const thunesOrder = [...fake.thunes.values()].find((entry) => entry.external_id.startsWith("po-") && entry.confirmed && entry.destination.amount === "64611");
    expect(thunesOrder).toBeDefined();
    const quotationCall = fake.calls.find((call) => call.url.endsWith("/v2/money-transfer/quotations") && call.body.includes(thunesOrder!.external_id));
    expect(JSON.parse(quotationCall!.body)).toMatchObject({ payer_id: "4021", mode: "DESTINATION_AMOUNT", source: { currency: "USD", country_iso_code: "FRA" }, destination: { amount: "64611", currency: "XOF" } });
    const transactionCall = fake.calls.find((call) => call.url.includes("/transactions") && call.body.includes(`"external_id":"${thunesOrder!.external_id}"`));
    expect(JSON.parse(transactionCall!.body)).toMatchObject({
      credit_party_identifier: { msisdn: "+221781112233" },
      beneficiary: { firstname: "Moussa", lastname: "Ndiaye" },
      sender: { firstname: "Aminata", lastname: "Diop", date_of_birth: "1988-02-14", country_iso_code: "FRA" },
      purpose_of_remittance: "EDUCATION",
    });

    thunesOrder!.status_class = "7";
    expect((await postThunes({ external_id: thunesOrder!.external_id, id: String(thunesOrder!.id), status_class: "7" })).status).toBe(200);
    expect(await transferStatus(transferId)).toBe("completed");
    expect(await journals(transferId)).toEqual([
      "transfer:T:funding",
      "transfer:T:payout:A",
      "transfer:T:payout_reversal:A",
      "transfer:T:payout:A",
      "transfer:T:payout_settlement:A",
      "transfer:T:payout_fee:A",
    ]);
    const history = await owner.query<{ to_status: string }>("SELECT to_status::text FROM transfers.status_history WHERE transfer_id = $1 ORDER BY id", [transferId]);
    expect(history.rows.map((row) => row.to_status)).toEqual(["created", "funded", "payout_pending", "payout_processing", "payout_failed", "payout_pending", "payout_processing", "completed"]);
  });

  it("rembourse le portefeuille quand toutes les routes échouent", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221781112244");
    fake.flutterwaveTransfers = "reject";
    fake.thunesQuotations = "reject";
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "gift", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    const transferId = response.body.transfer.id as string;
    expect(await transferStatus(transferId)).toBe("refunded");
    expect(await balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(50000n);
    expect(await balance({ type: "customer_hold", currency: "EUR", userId: customer.userId })).toBe(0n);
    expect(await journals(transferId)).toEqual([
      "transfer:T:funding",
      "transfer:T:payout:A",
      "transfer:T:payout_reversal:A",
      "transfer:T:payout:A",
      "transfer:T:payout_reversal:A",
      "transfer:T:refund",
    ]);
    const outbox = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_id = $1 ORDER BY id", [transferId]);
    expect(outbox.rows.map((row) => row.event_type)).toEqual(["transfers.created", "transfers.funded", "transfers.refund_started", "transfers.refunded"]);
  });

  it("attend sans double paiement quand l'issue est incertaine, puis réconcilie", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221781112255");
    fake.flutterwaveTransfers = "unavailable";
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    const transferId = response.body.transfer.id as string;
    expect(response.body.transfer.status).toBe("payout_processing");
    const attempts = await payoutAttempts(transferId);
    expect(attempts).toEqual([expect.objectContaining({ provider: "flutterwave", status: "pending", provider_reference: null }) as unknown]);
    const alert = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_type = 'payment_alert' AND payload->>'transfer_id' = $1", [transferId]);
    expect(alert.rows.map((row) => row.event_type)).toContain("payments.outcome_unknown");

    // Synchronisation : Flutterwave sans référence = réconciliation manuelle, jamais de nouvelle route.
    const attemptId = (await owner.query<{ id: string }>("SELECT id FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout'", [transferId])).rows[0]!.id;
    await age("payments.attempts", attemptId, "updated_at = now() - interval '10 minutes'");
    const result = await orchestrator.synchronize({ limit: 50, fundingTtlMinutes: 60 });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await payoutAttempts(transferId)).toHaveLength(1);
    expect(await transferStatus(transferId)).toBe("payout_processing");
  });
});

describe("transfert payé par carte (Stripe)", () => {
  function intentEvent(type: string, intentId: string): Record<string, unknown> {
    return { id: `evt_${randomBytes(8).toString("hex")}`, object: "event", type, data: { object: { id: intentId, object: "payment_intent" } } };
  }

  it("ouvre un PaymentIntent, finance au webhook signé puis paie le bénéficiaire", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const recipientId = await addRecipient(customer, "+221781112266");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "card"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    expect(response.body.transfer.status).toBe("awaiting_funding");
    expect(response.body.funding).toMatchObject({ type: "stripe_payment_intent", publishableKey: STRIPE_PUBLISHABLE });
    const transferId = response.body.transfer.id as string;
    const intent = [...fake.intents.values()].find((entry) => response.body.funding.clientSecret === entry.client_secret)!;
    expect(intent).toMatchObject({ amount: 10199, currency: "eur" });

    const resumed = await request(app).get(`/v1/transfers/${transferId}/funding`).set("Authorization", `Bearer ${customer.token}`);
    expect(resumed.body.funding.clientSecret).toBe(intent.client_secret);
    const secretStored = await owner.query("SELECT 1 FROM payments.attempts WHERE provider_response::text LIKE $1", [`%${intent.client_secret}%`]);
    expect(secretStored.rowCount).toBe(0);

    // Webhook mal signé ou trop ancien : refusé.
    expect((await postStripe(intentEvent("payment_intent.succeeded", intent.id), `whsec_${"z".repeat(32)}`)).status).toBe(401);
    expect((await postStripe(intentEvent("payment_intent.succeeded", intent.id), STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600)).status).toBe(401);
    expect(await transferStatus(transferId)).toBe("awaiting_funding");

    intent.status = "succeeded";
    intent.amount_received = 10199;
    intent.fee = 168;
    expect((await postStripe(intentEvent("payment_intent.succeeded", intent.id))).status).toBe(200);
    expect(await transferStatus(transferId)).toBe("payout_processing");
    expect(await journals(transferId)).toEqual(["transfer:T:funding", "transfer:T:payin_fee:A", "transfer:T:payout:A"]);
    expect(await balance({ type: "provider_fee_expense", currency: "EUR", provider: "stripe" })).toBeGreaterThanOrEqual(168n);

    // Rétrofacturation : fonds retirés puis rétablis.
    const dispute = { id: `dp_${randomBytes(6).toString("hex")}`, object: "dispute", payment_intent: intent.id, amount: 10199, currency: "eur" };
    const lossBefore = await balance({ type: "chargeback_loss", currency: "EUR" });
    expect((await postStripe({ id: `evt_${randomBytes(8).toString("hex")}`, type: "charge.dispute.funds_withdrawn", data: { object: dispute } })).status).toBe(200);
    expect(await balance({ type: "chargeback_loss", currency: "EUR" })).toBe(lossBefore + 10199n);
    expect((await postStripe({ id: `evt_${randomBytes(8).toString("hex")}`, type: "charge.dispute.funds_reinstated", data: { object: dispute } })).status).toBe(200);
    expect(await balance({ type: "chargeback_loss", currency: "EUR" })).toBe(lossBefore);
  });

  it("refuse de financer un montant encaissé différent et alerte", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const recipientId = await addRecipient(customer, "+221781112277");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "card"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    const transferId = response.body.transfer.id as string;
    const intent = [...fake.intents.values()].find((entry) => response.body.funding.clientSecret === entry.client_secret)!;
    intent.status = "succeeded";
    intent.amount_received = 10;
    await postStripe(intentEvent("payment_intent.succeeded", intent.id));
    expect(await transferStatus(transferId)).toBe("awaiting_funding");
    const alerts = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE payload->>'transfer_id' = $1 AND aggregate_type = 'payment_alert'", [transferId]);
    expect(alerts.rows.map((row) => row.event_type)).toEqual(["payments.payin_amount_mismatch"]);
  });

  it("annule à la demande du client avant paiement et rembourse la carte si le paiement sortant attend", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const recipientId = await addRecipient(customer, "+221781112288");
    const pending = await createTransfer(customer, { quoteId: await quote(customer, "card"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    const pendingIntent = [...fake.intents.values()].find((entry) => pending.body.funding.clientSecret === entry.client_secret)!;
    const cancelled = await request(app).post(`/v1/transfers/${pending.body.transfer.id as string}/cancel`).set("Authorization", `Bearer ${customer.token}`);
    expect(cancelled.body).toMatchObject({ status: "cancelled", statusReason: "cancelled_by_customer" });
    expect(pendingIntent.status).toBe("canceled");

    // Prestataires de paiement sortant indisponibles : le transfert financé attend, puis le client annule.
    await owner.query("UPDATE payments.provider_health SET circuit_state = 'open', opened_at = now(), next_probe_at = now() + interval '1 hour' WHERE provider IN ('flutterwave', 'thunes')");
    const funded = await createTransfer(customer, { quoteId: await quote(customer, "card"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    const transferId = funded.body.transfer.id as string;
    const intent = [...fake.intents.values()].find((entry) => funded.body.funding.clientSecret === entry.client_secret)!;
    intent.status = "succeeded";
    intent.amount_received = 10199;
    await postStripe(intentEvent("payment_intent.succeeded", intent.id));
    expect(await transferStatus(transferId)).toBe("payout_pending");

    const refunded = await request(app).post(`/v1/transfers/${transferId}/cancel`).set("Authorization", `Bearer ${customer.token}`);
    expect(refunded.body.status).toBe("refunded");
    const refund = [...fake.refunds.values()].find((entry) => entry.payment_intent === intent.id);
    expect(refund).toMatchObject({ amount: 10199, status: "succeeded" });
    expect(await journals(transferId)).toEqual(["transfer:T:funding", "transfer:T:refund"]);
    expect(await balance({ type: "customer_hold", currency: "EUR", userId: customer.userId })).toBe(0n);
  });
});

describe("transfert payé par virement (Flutterwave)", () => {
  it("exige un e-mail, renvoie la page de paiement, annule à l'expiration et isole un paiement tardif", async () => {
    const withoutEmail = await verifiedCustomer({ walletEur: 0n, email: false });
    const blocked = await createTransfer(withoutEmail, { quoteId: await quote(withoutEmail, "bank_transfer"), recipientId: await addRecipient(withoutEmail), purposeCode: "family_support", totpCode: totp(withoutEmail) });
    expect(blocked.status).toBe(422);

    const customer = await verifiedCustomer({ walletEur: 0n });
    const recipientId = await addRecipient(customer, "+221781112299");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "bank_transfer"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    expect(response.body.funding.type).toBe("redirect");
    expect(response.body.funding.url).toMatch(/^https:\/\/checkout\.flutterwave\.test\/pay\/pi-/);
    const transferId = response.body.transfer.id as string;
    const txRef = (response.body.funding.url as string).split("/").pop()!;
    expect(fake.calls.find((call) => call.url.endsWith("/v3/payments") && call.body.includes(txRef))?.body).toContain('"amount":101.99');

    // Expiration : aucun paiement constaté, transfert annulé.
    await age("transfers.transfers", transferId, "created_at = now() - interval '2 hours'");
    await orchestrator.synchronize({ limit: 100, fundingTtlMinutes: 60 });
    expect(await transferStatus(transferId)).toBe("cancelled");

    // Paiement arrivé après l'annulation : compte d'attente et alerte, jamais de transfert.
    fake.flwPayins.set(txRef, { id: 9_000_001, amount: "101.99", currency: "EUR", status: "successful", app_fee: "1.4" });
    const suspenseBefore = await balance({ type: "suspense", currency: "EUR" });
    expect((await postFlutterwave({ event: "charge.completed", data: { id: 9_000_001, tx_ref: txRef, status: "successful" } })).status).toBe(200);
    expect(await transferStatus(transferId)).toBe("cancelled");
    expect(await balance({ type: "suspense", currency: "EUR" })).toBe(suspenseBefore - 10199n);
    const alerts = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_type = 'payment_alert' AND payload->>'transfer_id' = $1", [transferId]);
    expect(alerts.rows.map((row) => row.event_type)).toContain("payments.late_payin");
  });

  it("finance un virement constaté par relecture (montant exact) et synchronise un paiement sortant sans webhook", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const recipientId = await addRecipient(customer, "+221781112200");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "bank_transfer"), recipientId, purposeCode: "household_expenses", totpCode: totp(customer) });
    const transferId = response.body.transfer.id as string;
    const txRef = (response.body.funding.url as string).split("/").pop()!;
    fake.flwPayins.set(txRef, { id: 9_000_002, amount: "101.99", currency: "EUR", status: "successful", app_fee: "1.425" });
    await postFlutterwave({ event: "charge.completed", data: { id: 9_000_002, tx_ref: txRef, status: "successful" } });
    expect(await transferStatus(transferId)).toBe("payout_processing");
    const fee = await owner.query<{ amount: string }>(
      "SELECT e.amount::text FROM ledger.entries e JOIN ledger.journals j ON j.id = e.journal_id WHERE j.idempotency_key LIKE $1 AND e.direction = 'debit'",
      [`transfer:${transferId}:payin_fee:%`],
    );
    expect(fee.rows[0]?.amount).toBe("143");

    const order = [...fake.flwTransfers.values()].find((entry) => entry.account_number === "221781112200")!;
    order.status = "SUCCESSFUL";
    const attemptId = (await owner.query<{ id: string }>("SELECT id FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout'", [transferId])).rows[0]!.id;
    await age("payments.attempts", attemptId, "updated_at = now() - interval '10 minutes'");
    await orchestrator.synchronize({ limit: 100, fundingTtlMinutes: 60 });
    expect(await transferStatus(transferId)).toBe("completed");
  });
});

describe("disjoncteur", () => {
  it("s'ouvre après des échecs techniques, n'autorise qu'une sonde, se referme sur succès", async () => {
    const breaker = new CircuitBreaker(apiPool, { failureThreshold: 3, openSeconds: 60 });
    const failing = (): Promise<never> => Promise.reject(new PaymentProviderError("thunes", "HTTP 503", true, false));
    for (let index = 0; index < 3; index += 1) await expect(breaker.run("thunes", failing)).rejects.toThrow();
    expect(await breaker.canUse("thunes")).toBe(false);
    await owner.query("UPDATE payments.provider_health SET next_probe_at = now() - interval '1 second' WHERE provider = 'thunes'");
    expect(await breaker.canUse("thunes")).toBe(true);
    expect(await breaker.canUse("thunes")).toBe(false);
    await breaker.run("thunes", () => Promise.resolve("ok"));
    expect(await breaker.canUse("thunes")).toBe(true);
    // Un refus métier n'ouvre pas le disjoncteur.
    for (let index = 0; index < 5; index += 1) {
      await expect(breaker.run("thunes", () => Promise.reject(new PaymentProviderError("thunes", "HTTP 400", false, false)))).rejects.toThrow();
    }
    expect(await breaker.canUse("thunes")).toBe(true);
  });
});
