import { randomUUID } from "node:crypto";

import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OutboxDispatchJob } from "../src/jobs/outboxDispatch.job.js";
import { SmsDeliveryError } from "../src/lib/sms/smsSender.js";
import type { SmsSender } from "../src/lib/sms/smsSender.js";
import { renderNotification } from "../src/modules/notifications/customerNotifier.js";
import { definitionOf, EVENT_CATALOG, loggablePayload } from "../src/modules/notifications/eventCatalog.js";
import type { NotificationTemplate } from "../src/modules/notifications/eventCatalog.js";
import { createOutboxDispatcher } from "../src/modules/notifications/index.js";
import { retryDelaySeconds } from "../src/modules/notifications/outboxDispatcher.js";
import type { OutboxDispatcher } from "../src/modules/notifications/outboxDispatcher.js";
import { createPaymentHarness } from "./support/paymentHarness.js";

/**
 * Consommateur de l'outbox : journal d'exploitation, notifications des
 * clients (issues de transferts et d'identité seulement), reprises et
 * abandon.
 */

// =============================================================================
// Tests unitaires
// =============================================================================

describe("catalogue et modèles", () => {
  it("ne notifie au client aucun événement de conformité", () => {
    const notified = Object.entries(EVENT_CATALOG).filter(([, definition]) => definition.notify !== undefined).map(([type]) => type).sort();
    expect(notified).toEqual([
      "customers.password_reset",
      "kyc.resubmission_required",
      "kyc.verification_approved",
      "kyc.verification_rejected",
      "transfers.cancelled",
      "transfers.completed",
      "transfers.refunded",
    ]);
    for (const type of ["transfers.held_for_review", "aml.transfer_review_required", "aml.alert_raised", "aml.sar_filed", "kyc.review_required", "transfers.compliance_released"]) {
      expect(definitionOf(type)?.notify, type).toBeUndefined();
    }
    expect(definitionOf("toString")).toBeUndefined();
    expect(definitionOf("payments.payout_amount_mismatch")?.severity).toBe("critical");
  });

  it("rédige des SMS courts, sans motif ni nom, dans l'alphabet GSM", () => {
    const templates: NotificationTemplate[] = ["transfer_completed", "transfer_refunded", "transfer_cancelled", "kyc_approved", "kyc_rejected", "kyc_resubmission_required", "password_changed"];
    for (const template of templates) {
      const body = renderNotification(template, { reference: "TP-ABC123", received: "64 611 F CFA" });
      expect(body.startsWith("TransfertPlus : ")).toBe(true);
      expect(body.length).toBeLessThanOrEqual(160);
      expect(body).not.toMatch(/[\u00a0\u202f\u2019]/);
    }
    expect(renderNotification("transfer_completed", { reference: "TP-ABC123", received: "64 611 F CFA" })).toBe(
      "TransfertPlus : votre envoi TP-ABC123 est arrivé. Le bénéficiaire a reçu 64 611 F CFA.",
    );
    expect(renderNotification("transfer_refunded", { reference: "R", refundDestination: "payment_source" })).toContain("moyen de paiement");
    expect(renderNotification("transfer_refunded", { reference: "R", refundDestination: "wallet" })).toContain("portefeuille");
  });

  it("réduit la charge utile journalisée aux identifiants, codes et nombres", () => {
    expect(loggablePayload({ transfer_id: "6f1c0d1e-0000-4000-8000-000000000001", provider: "flutterwave", attempts: 3, manual: true, reasons: ["document illisible"], last_error: "Jean Dupont : refus", amount: Number.NaN })).toEqual({
      transfer_id: "6f1c0d1e-0000-4000-8000-000000000001",
      provider: "flutterwave",
      attempts: 3,
      manual: true,
    });
  });

  it("espace les essais de façon croissante, plafonnée à une heure", () => {
    expect([1, 2, 3, 4, 6, 7, 20].map(retryDelaySeconds)).toEqual([60, 120, 240, 480, 1920, 3600, 3600]);
  });
});

// =============================================================================
// Intégration (base réelle)
// =============================================================================

class RecordingSms implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];
  failures: Error[] = [];

  send(toE164: string, body: string): Promise<{ readonly providerMessageId: string }> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.sent.push({ to: toE164, body });
    return Promise.resolve({ providerMessageId: `SM${randomUUID().replaceAll("-", "")}` });
  }
}

const harness = await createPaymentHarness();
const { owner, apiPool, config, encryptor, verifiedCustomer, totp, addRecipient, quote, createTransfer, transferStatus, postFlutterwave, fake } = harness;
const sms = new RecordingSms();
const logs: Record<string, unknown>[] = [];
const logger = pino({ level: "info" }, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
const workerId = `test-worker:${randomUUID()}`;
let dispatcher: OutboxDispatcher;

/** Isole le fichier : les événements laissés par les autres fichiers sont marqués publiés. */
async function drainForeignEvents(): Promise<void> {
  await owner.query(
    `UPDATE integrations.outbox SET status = 'published', published_at = now(), locked_by = NULL, locked_until = NULL
      WHERE status IN ('pending', 'failed', 'processing')`,
  );
}

async function outboxRow(id: string): Promise<{ status: string; attempts: number; last_error: string | null; available_at: Date }> {
  const result = await owner.query<{ status: string; attempts: number; last_error: string | null; available_at: Date }>(
    "SELECT status::text, attempts, last_error, available_at FROM integrations.outbox WHERE id = $1",
    [id],
  );
  return result.rows[0]!;
}

async function emit(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload), `test-notifications:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function kycVerificationOf(userId: string): Promise<string> {
  const result = await owner.query<{ id: string }>("SELECT id FROM kyc.verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]);
  return result.rows[0]!.id;
}

/** Remet un événement à disposition immédiate (délai de reprise écoulé). */
async function makeAvailable(id: string): Promise<void> {
  await owner.query("UPDATE integrations.outbox SET available_at = now() WHERE id = $1", [id]);
}

beforeAll(async () => {
  await harness.setup();
  dispatcher = createOutboxDispatcher({ config, pool: apiPool, logger, encryptor, workerId, sms });
});
beforeEach(async () => {
  await harness.resetEach();
  await drainForeignEvents();
  sms.sent.length = 0;
  sms.failures = [];
  logs.length = 0;
});
afterAll(harness.teardown);

describe("distribution de l'outbox", () => {
  it("notifie l'arrivée d'un envoi une seule fois et publie tout le cycle de vie", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer);
    const quoteId = await quote(customer, "wallet_balance");
    const created = await createTransfer(customer, { quoteId, recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(created.status).toBe(201);
    const transfer = created.body.transfer as { id: string; reference: string };
    const order = [...fake.flwTransfers.values()].find((entry) => entry.reference.startsWith("po-") && entry.account_number === "221771234567");
    order!.status = "SUCCESSFUL";
    expect((await postFlutterwave({ event: "transfer.completed", data: { id: order!.id, reference: order!.reference, status: "SUCCESSFUL" } })).status).toBe(200);
    expect(await transferStatus(transfer.id)).toBe("completed");

    const result = await dispatcher.dispatchBatch(50);
    expect(result).toMatchObject({ claimed: 3, published: 3, retried: 0, dead: 0, notified: 1 });
    expect(sms.sent).toEqual([{ to: "+33612345678", body: `TransfertPlus : votre envoi ${transfer.reference} est arrivé. Le bénéficiaire a reçu 64 611 F CFA.` }]);
    const events = await owner.query<{ event_type: string; status: string }>(
      "SELECT event_type, status::text FROM integrations.outbox WHERE aggregate_id = $1 ORDER BY id",
      [transfer.id],
    );
    expect(events.rows).toEqual([
      { event_type: "transfers.created", status: "published" },
      { event_type: "transfers.funded", status: "published" },
      { event_type: "transfers.completed", status: "published" },
    ]);
    const notification = await owner.query<{ user_id: string; template: string; status: string; provider_message_id: string }>(
      "SELECT n.user_id, n.template, n.status::text, n.provider_message_id FROM integrations.customer_notifications n JOIN integrations.outbox o ON o.id = n.outbox_id WHERE o.aggregate_id = $1",
      [transfer.id],
    );
    expect(notification.rows).toEqual([{ user_id: customer.userId, template: "transfer_completed", status: "sent", provider_message_id: expect.stringMatching(/^SM[0-9a-f]{32}$/) as unknown }]);

    // Événement repris (bail perdu après l'envoi) : aucun second SMS.
    await owner.query("UPDATE integrations.outbox SET status = 'pending', published_at = NULL WHERE aggregate_id = $1 AND event_type = 'transfers.completed'", [transfer.id]);
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 1, notified: 0 });
    expect(sms.sent).toHaveLength(1);

    // Journal d'exploitation : sans numéro ni nom.
    const entry = logs.find((line) => line["eventType"] === "transfers.completed");
    expect(entry).toMatchObject({ level: 30, aggregateType: "transfer", aggregateId: transfer.id, severity: "info", payload: { transfer_id: transfer.id, provider: "flutterwave" } });
    expect(JSON.stringify(logs)).not.toContain("33612345678");
    expect(JSON.stringify(logs)).not.toContain("Moussa");
  });

  it("notifie les décisions d'identité, jamais une mise en revue ni une alerte de conformité", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const verificationId = await kycVerificationOf(customer.userId);
    await emit("kyc_verification", verificationId, "kyc.review_required", { verification_id: verificationId, user_id: customer.userId });
    await emit("transfer", randomUUID(), "aml.transfer_review_required", { rule: "STRUCTURING" });
    const breach = await emit("ledger", randomUUID(), "ledger.integrity_breach", { detail: "écart détecté sur le compte de Jean" });
    await emit("kyc_verification", verificationId, "kyc.verification_approved", { verification_id: verificationId, user_id: customer.userId, tier: "tier_1" });

    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 4, published: 4, notified: 1 });
    expect(sms.sent.map((message) => message.body)).toEqual(["TransfertPlus : votre identité est vérifiée. Vous pouvez désormais envoyer de l'argent."]);
    expect((await outboxRow(breach)).status).toBe("published");
    const critical = logs.find((line) => line["eventType"] === "ledger.integrity_breach");
    expect(critical).toMatchObject({ level: 50, severity: "critical", payload: {} });
    expect(logs.find((line) => line["eventType"] === "aml.transfer_review_required")).toMatchObject({ level: 40, severity: "warning", payload: { rule: "STRUCTURING" } });
  });

  it("reprend un envoi en échec temporaire, abandonne un numéro refusé, et ne notifie pas un compte clôturé", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const verificationId = await kycVerificationOf(customer.userId);
    const event = await emit("kyc_verification", verificationId, "kyc.resubmission_required", { verification_id: verificationId });

    sms.failures = [new SmsDeliveryError("Twilio a refusé l'envoi (HTTP 503, code ?)", true)];
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 0, retried: 1 });
    const failed = await outboxRow(event);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, last_error: expect.stringContaining("HTTP 503") as unknown });
    expect(failed.available_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 0 });
    const pending = await owner.query<{ status: string; last_error: string }>("SELECT status::text, last_error FROM integrations.customer_notifications WHERE outbox_id = $1", [event]);
    expect(pending.rows).toEqual([{ status: "sending", last_error: expect.stringContaining("HTTP 503") as unknown }]);

    await makeAvailable(event);
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 1, notified: 1 });
    expect(sms.sent.map((message) => message.body)).toEqual(["TransfertPlus : un nouveau document est nécessaire pour vérifier votre identité. Ouvrez l'application pour le transmettre."]);
    expect((await owner.query("SELECT 1 FROM integrations.customer_notifications WHERE outbox_id = $1 AND status = 'sent' AND last_error IS NULL", [event])).rowCount).toBe(1);

    // Refus définitif : notification abandonnée, événement publié.
    const rejected = await emit("kyc_verification", verificationId, "kyc.verification_rejected", { verification_id: verificationId });
    sms.failures = [new SmsDeliveryError("numéro de destination invalide", false)];
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 1, notified: 0 });
    expect((await outboxRow(rejected)).status).toBe("published");
    expect((await owner.query("SELECT 1 FROM integrations.customer_notifications WHERE outbox_id = $1 AND status = 'failed'", [rejected])).rowCount).toBe(1);
    await owner.query("UPDATE integrations.outbox SET status = 'pending', published_at = NULL WHERE id = $1", [rejected]);
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 1, notified: 0 });
    expect(sms.sent).toHaveLength(1);

    // Compte clôturé : aucun message.
    const closed = await verifiedCustomer({ walletEur: 0n });
    await owner.query("UPDATE identity.users SET status = 'closed', closed_at = now() WHERE id = $1", [closed.userId]);
    await emit("kyc_verification", await kycVerificationOf(closed.userId), "kyc.verification_approved", {});
    expect(await dispatcher.dispatchBatch(50)).toMatchObject({ claimed: 1, published: 1, notified: 0 });
    expect(sms.sent).toHaveLength(1);
  });

  it("abandonne au dernier essai, enterre les réservations orphelines et signale l'abandon", async () => {
    const customer = await verifiedCustomer({ walletEur: 0n });
    const verificationId = await kycVerificationOf(customer.userId);
    const last = await emit("kyc_verification", verificationId, "kyc.verification_approved", {});
    await owner.query("UPDATE integrations.outbox SET attempts = 19 WHERE id = $1", [last]);
    const orphan = await emit("transfer", randomUUID(), "transfers.created", {});
    await owner.query(
      "UPDATE integrations.outbox SET status = 'processing', attempts = max_attempts, locked_by = 'worker-tombé', locked_until = now() - interval '1 minute' WHERE id = $1",
      [orphan],
    );
    const unknown = await emit("misc", randomUUID(), "misc.unlisted_event", { code: "x" });

    sms.failures = [new SmsDeliveryError("Twilio a refusé l'envoi (HTTP 500, code ?)", true)];
    const job = new OutboxDispatchJob(dispatcher, logger, 10_000, 50, 3);
    await expect(job.run()).rejects.toThrow("2 événement(s) de l'outbox abandonné(s)");
    expect((await outboxRow(last)).status).toBe("dead");
    expect(await outboxRow(orphan)).toMatchObject({ status: "dead", last_error: "réservation expirée au dernier essai" });
    expect((await outboxRow(unknown)).status).toBe("published");
    expect(logs.find((line) => line["eventType"] === "misc.unlisted_event")).toMatchObject({ level: 40, msg: "événement de l'outbox non répertorié" });
    expect(logs.find((line) => line["outboxId"] === last && line["level"] === 50)).toBeDefined();

    // Rien à distribuer : la tâche se termine sans bruit.
    logs.length = 0;
    await expect(job.run()).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("enchaîne les lots jusqu'à épuisement de l'outbox", async () => {
    for (let index = 0; index < 5; index++) await emit("transfer", randomUUID(), "transfers.created", {});
    const job = new OutboxDispatchJob(dispatcher, logger, 10_000, 2, 10);
    await job.run();
    expect(logs.find((line) => line["msg"] === "outbox distribuée")).toMatchObject({ claimed: 5, published: 5 });
  });
});
