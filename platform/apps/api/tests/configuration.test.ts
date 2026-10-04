import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPaymentHarness } from "./support/paymentHarness.js";
import { createStaffKit } from "./support/staffKit.js";
import type { Staff } from "./support/staffKit.js";

/**
 * Paramétrage depuis le back-office (phase 18) : consultation
 * (configuration:read), modifications en double validation, écriture à
 * l'identique de la demande approuvée, aperçu du prix client.
 *
 * Périmètres dédiés (CHF → MAD, Maroc) pour ne pas modifier le paramétrage
 * des autres suites qui partagent la base ; tout est rétabli à la fin.
 */

const harness = await createPaymentHarness();
const { owner, app } = harness;
const { staff, as } = createStaffKit({ app, owner });

let adminA: Staff;
let adminB: Staff;
let analyst: Staff;
let support: Staff;
const createdRules: string[] = [];
const createdSchedules: string[] = [];
const createdCorridors: string[] = [];

beforeAll(async () => {
  await harness.setup();
  [adminA, adminB, analyst, support] = await Promise.all([staff(["super_admin"]), staff(["super_admin"]), staff(["risk_manager"]), staff(["support"])]);
});
beforeEach(harness.resetEach);
afterAll(async () => {
  // Règles programmées : closes dès leur date d'effet (jamais actives).
  await owner.query(
    "UPDATE fx.pricing_rules SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond') WHERE id = ANY($1::uuid[]) AND (valid_to IS NULL OR valid_to > now())",
    [createdRules],
  );
  await owner.query(
    "UPDATE transfers.fee_schedules SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond') WHERE id = ANY($1::uuid[]) AND (valid_to IS NULL OR valid_to > now())",
    [createdSchedules],
  );
  await owner.query("UPDATE payments.payout_corridors SET is_enabled = false WHERE id = ANY($1::uuid[])", [createdCorridors]);
  await owner.query("UPDATE ref.countries SET can_send = false, can_receive = false WHERE alpha2 = 'MA'");
  await owner.query("UPDATE payments.providers SET is_enabled = true WHERE code = 'thunes'");
  await harness.teardown();
});

/** Demande par A, approbation (et exécution) par B. */
async function approved(path: string, body: Record<string, unknown>, requester: Staff = adminA, approver: Staff = adminB): Promise<{ readonly approvalId: string; readonly result: Record<string, unknown> }> {
  const requested = await as(requester).post(path, body);
  expect(requested.status, JSON.stringify(requested.body)).toBe(202);
  const approvalId = requested.body.id as string;
  const executed = await as(approver).post(`/v1/admin/approvals/${approvalId}/approve`);
  expect(executed.status, JSON.stringify(executed.body)).toBe(200);
  return { approvalId, result: executed.body.result as Record<string, unknown> };
}

describe("habilitations", () => {
  it("réserve la consultation à configuration:read et chaque modification à sa permission", async () => {
    expect((await as(support).get("/v1/admin/configuration/pricing-rules")).status).toBe(403);
    for (const path of ["pricing-rules", "fee-schedules", "payout-corridors", "payin-methods", "providers", "countries"]) {
      expect((await as(analyst).get(`/v1/admin/configuration/${path}`)).status, path).toBe(200);
    }
    const denied = await as(analyst).post("/v1/admin/configuration/pricing-rule-requests", { marginBps: 100, justification: "Ajustement de la marge" });
    expect(denied.status).toBe(403);
    const country = await as(analyst).post("/v1/admin/configuration/countries/MA/change-requests", { canSend: false, canReceive: true, riskLevel: "medium", justification: "Ouverture du Maroc" });
    expect(country.status).toBe(403);
  });
});

describe("marges de change", () => {
  it("crée une marge à l'identique de la demande, au nom du demandeur, puis la remplace", async () => {
    const created = await approved("/v1/admin/configuration/pricing-rule-requests", {
      sourceCurrency: "CHF",
      destinationCurrency: "MAD",
      marginBps: 180,
      priority: 5,
      justification: "Ouverture du corridor Suisse → Maroc",
    });
    const firstId = created.result["pricingRuleId"] as string;
    createdRules.push(firstId);
    const row = await owner.query<{ margin_bps: number; created_by_admin_id: string; valid_to: Date | null }>(
      "SELECT margin_bps, created_by_admin_id, valid_to FROM fx.pricing_rules WHERE id = $1",
      [firstId],
    );
    expect(row.rows[0]).toMatchObject({ margin_bps: 180, created_by_admin_id: adminA.adminId, valid_to: null });

    // Le demandeur ne statue pas sur sa propre demande.
    const own = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { sourceCurrency: "CHF", destinationCurrency: "MAD", marginBps: 160, justification: "Baisse de la marge" });
    expect(own.status).toBe(202);
    expect((await as(adminA).post(`/v1/admin/approvals/${own.body.id as string}/approve`)).status).toBe(403);
    // Signalée sur la cible… mais pas tant qu'elle ne vise que la création de la nouvelle marge.
    const pendingList = await as(analyst).get("/v1/admin/configuration/pricing-rules");
    expect((pendingList.body.items as { id: string; pendingRequestId: string | null }[]).find((item) => item.id === firstId)?.pendingRequestId).toBeNull();
    expect((await as(adminB).post(`/v1/admin/approvals/${own.body.id as string}/reject`, { note: "Remplacée par la demande suivante" })).status).toBe(200);

    const replacing = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", {
      sourceCurrency: "CHF",
      destinationCurrency: "MAD",
      marginBps: 150,
      priority: 5,
      replacesRuleId: firstId,
      justification: "Alignement sur la concurrence",
    });
    expect(replacing.status).toBe(202);
    // La marge remplacée signale la demande qui la clôt.
    const flagged = await as(analyst).get("/v1/admin/configuration/pricing-rules");
    expect((flagged.body.items as { id: string; pendingRequestId: string | null }[]).find((item) => item.id === firstId)?.pendingRequestId).toBe(replacing.body.id);
    const executedReplacement = await as(adminB).post(`/v1/admin/approvals/${replacing.body.id as string}/approve`);
    expect(executedReplacement.status).toBe(200);
    const replaced = { result: executedReplacement.body.result as Record<string, unknown> };
    createdRules.push(replaced.result["pricingRuleId"] as string);
    const list = await as(analyst).get("/v1/admin/configuration/pricing-rules?state=all");
    const states = new Map((list.body.items as { id: string; state: string; marginBps: number }[]).map((item) => [item.id, item]));
    expect(states.get(firstId)?.state).toBe("ended");
    expect(states.get(replaced.result["pricingRuleId"] as string)).toMatchObject({ state: "active", marginBps: 150 });
    // Une règle close n'apparaît plus dans la vue courante.
    const current = await as(analyst).get("/v1/admin/configuration/pricing-rules");
    expect((current.body.items as { id: string }[]).some((item) => item.id === firstId)).toBe(false);
  });

  it("programme une marge future et refuse les demandes incohérentes", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await approved("/v1/admin/configuration/pricing-rule-requests", {
      sourceCurrency: "CHF",
      destinationCurrency: "MAD",
      marginBps: 140,
      priority: 6,
      validFrom: tomorrow,
      justification: "Promotion programmée",
    });
    createdRules.push(scheduled.result["pricingRuleId"] as string);
    const list = await as(adminA).get("/v1/admin/configuration/pricing-rules");
    expect((list.body.items as { id: string; state: string }[]).find((item) => item.id === scheduled.result["pricingRuleId"])?.state).toBe("scheduled");

    const past = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { marginBps: 100, validFrom: new Date(Date.now() - 60_000).toISOString(), justification: "Effet rétroactif refusé" });
    expect(past.status).toBe(400);
    const tooFar = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { marginBps: 100, validFrom: new Date(Date.now() + 120 * 86_400_000).toISOString(), justification: "Trop lointain" });
    expect(tooFar.status).toBe(400);
    const sameCurrency = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { sourceCurrency: "CHF", destinationCurrency: "CHF", marginBps: 100, justification: "Aucune conversion" });
    expect(sameCurrency.status).toBe(400);
    const outOfRange = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { marginBps: 2000, justification: "Marge excessive" });
    expect(outOfRange.status).toBe(400);
    const unknownReplace = await as(adminA).post("/v1/admin/configuration/pricing-rule-requests", { marginBps: 100, replacesRuleId: "00000000-0000-4000-8000-000000000000", justification: "Remplacement introuvable" });
    expect(unknownReplace.status).toBe(404);
  });
});

describe("barèmes de frais", () => {
  it("crée puis clôt un barème, sans jamais repousser une clôture", async () => {
    const created = await approved("/v1/admin/configuration/fee-schedule-requests", {
      sourceCurrency: "CHF",
      destinationCountry: "MA",
      payoutMethod: "bank_account",
      fixedFee: "300",
      percentageBps: 75,
      minFee: "300",
      maxFee: "2500",
      priority: 3,
      justification: "Barème du corridor Suisse → Maroc",
    });
    const id = created.result["feeScheduleId"] as string;
    createdSchedules.push(id);
    const list = await as(analyst).get("/v1/admin/configuration/fee-schedules");
    expect((list.body.items as { id: string }[]).find((item) => item.id === id)).toMatchObject({ fixedFee: "300", percentageBps: 75, maxFee: "2500", payoutMethod: "bank_account", createdBy: { id: adminA.adminId } });

    const invalid = await as(adminA).post("/v1/admin/configuration/fee-schedule-requests", { sourceCurrency: "CHF", fixedFee: "0", percentageBps: 0, minFee: "500", maxFee: "100", justification: "Plafond incohérent" });
    expect(invalid.status).toBe(400);

    const inThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await approved(`/v1/admin/configuration/fee-schedules/${id}/closure-requests`, { validTo: inThirtyDays, justification: "Fin de l'offre de lancement" });
    const later = await as(adminA).post(`/v1/admin/configuration/fee-schedules/${id}/closure-requests`, { validTo: new Date(Date.now() + 60 * 86_400_000).toISOString(), justification: "Prolongation refusée" });
    expect(later.status).toBe(409);
    await approved(`/v1/admin/configuration/fee-schedules/${id}/closure-requests`, { justification: "Arrêt immédiat du barème" });
    const closed = await owner.query<{ ended: boolean }>("SELECT valid_to <= now() AS ended FROM transfers.fee_schedules WHERE id = $1", [id]);
    expect(closed.rows[0]?.ended).toBe(true);
  });
});

describe("pays, corridors et prestataires", () => {
  it("n'active un corridor que vers un pays ouvert, puis en modifie les paramètres", async () => {
    const corridorRequest = await as(adminA).post("/v1/admin/configuration/payout-corridor-requests", {
      destinationCountry: "MA",
      destinationCurrency: "MAD",
      payoutMethod: "bank_account",
      provider: "flutterwave",
      priority: 10,
      minAmount: "5000",
      maxAmount: "5000000",
      costFixed: "0",
      costBps: 90,
      estimatedDeliveryMinutes: 60,
      isEnabled: true,
      justification: "Virements bancaires vers le Maroc",
    });
    expect(corridorRequest.status).toBe(202);
    const corridorApproval = corridorRequest.body.id as string;
    // Maroc fermé à la réception : l'exécution échoue, la demande reste en attente.
    const refused = await as(adminB).post(`/v1/admin/approvals/${corridorApproval}/approve`);
    expect(refused.status).toBe(422);
    expect((await as(adminB).get(`/v1/admin/approvals/${corridorApproval}`)).body.status).toBe("pending");

    const prohibited = await as(adminA).post("/v1/admin/configuration/countries/MA/change-requests", { canSend: false, canReceive: true, riskLevel: "prohibited", justification: "Incohérent" });
    expect(prohibited.status).toBe(400);
    await approved("/v1/admin/configuration/countries/MA/change-requests", { canSend: false, canReceive: true, riskLevel: "medium", justification: "Ouverture du Maroc à la réception" });
    const countries = await as(analyst).get("/v1/admin/configuration/countries");
    expect((countries.body.items as { code: string }[]).find((item) => item.code === "MA")).toMatchObject({ canReceive: true, canSend: false, riskLevel: "medium" });

    const executed = await as(adminB).post(`/v1/admin/approvals/${corridorApproval}/approve`);
    expect(executed.status).toBe(200);
    const corridorId = executed.body.result.corridorId as string;
    createdCorridors.push(corridorId);

    const duplicate = await as(adminA).post("/v1/admin/configuration/payout-corridor-requests", {
      destinationCountry: "MA", destinationCurrency: "MAD", payoutMethod: "bank_account", provider: "flutterwave", priority: 1,
      minAmount: "1", maxAmount: "2", costFixed: "0", costBps: 0, estimatedDeliveryMinutes: 1, isEnabled: false, justification: "Doublon refusé",
    });
    expect(duplicate.status).toBe(409);

    await approved(`/v1/admin/configuration/payout-corridors/${corridorId}/change-requests`, {
      priority: 10, minAmount: "5000", maxAmount: "2000000", costFixed: "0", costBps: 90, estimatedDeliveryMinutes: 60, isEnabled: false, justification: "Suspension et baisse du plafond",
    });
    const corridors = await as(analyst).get("/v1/admin/configuration/payout-corridors");
    expect((corridors.body.items as { id: string }[]).find((item) => item.id === corridorId)).toMatchObject({ isEnabled: false, maxAmount: "2000000", provider: "flutterwave", providerEnabled: true });
  });

  it("signale la demande en attente sur sa cible et coupe un prestataire après approbation", async () => {
    const pending = await as(adminA).post("/v1/admin/configuration/providers/thunes/change-requests", { isEnabled: false, justification: "Incident chez le prestataire" });
    expect(pending.status).toBe(202);
    const providers = await as(analyst).get("/v1/admin/configuration/providers");
    expect((providers.body.items as { code: string }[]).find((item) => item.code === "thunes")).toMatchObject({ isEnabled: true, pendingRequestId: pending.body.id });
    // Une seule demande en cours par cible.
    expect((await as(adminB).post("/v1/admin/configuration/providers/thunes/change-requests", { isEnabled: false, justification: "Même incident" })).status).toBe(409);
    expect((await as(adminB).post(`/v1/admin/approvals/${pending.body.id as string}/approve`)).status).toBe(200);
    const after = await as(analyst).get("/v1/admin/configuration/providers");
    expect((after.body.items as { code: string }[]).find((item) => item.code === "thunes")).toMatchObject({ isEnabled: false, pendingRequestId: null });
    expect((await as(adminA).post("/v1/admin/configuration/providers/thunes/change-requests", { isEnabled: false, justification: "Déjà coupé" })).status).toBe(409);
  });
});

describe("aperçu du prix client", () => {
  it("calcule le prix courant et nomme les règles appliquées, sans enregistrer de devis", async () => {
    // Taux frais et tarification du corridor France → Sénégal (closes à la fin de la suite).
    await owner.query(
      `INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
       VALUES ('open_exchange_rates', 'USD', 'EUR', 0.92, now() - interval '1 minute'),
              ('open_exchange_rates', 'USD', 'XOF', 603.48, now() - interval '1 minute')`,
    );
    const rule = await owner.query<{ id: string }>(
      "INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps, priority, valid_from) VALUES ('EUR', 'XOF', 150, 10, now() - interval '1 second') RETURNING id",
    );
    const schedule = await owner.query<{ id: string }>(
      "INSERT INTO transfers.fee_schedules (source_currency, fixed_fee, percentage_bps, min_fee, priority, valid_from) VALUES ('EUR', 199, 0, 0, 0, now() - interval '1 second') RETURNING id",
    );
    createdRules.push(rule.rows[0]!.id);
    createdSchedules.push(schedule.rows[0]!.id);
    const before = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM fx.quotes");
    const preview = await as(analyst).post("/v1/admin/configuration/quote-preview", {
      sourceCountry: "FR",
      destinationCountry: "SN",
      sourceCurrency: "EUR",
      destinationCurrency: "XOF",
      payoutMethod: "mobile_money",
      fundingMethod: "card",
      amount: "10000",
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ sendAmount: { amount: "10000", currency: "EUR" }, receiveAmount: { currency: "XOF" } });
    expect(preview.body).toMatchObject({ pricingRuleId: rule.rows[0]!.id, feeScheduleId: schedule.rows[0]!.id, marginBps: 150, fee: { amount: "199", currency: "EUR" } });
    const after = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM fx.quotes");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
