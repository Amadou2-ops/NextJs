import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_ORIGIN } from "./support/fixtures.js";
import { createPaymentHarness } from "./support/paymentHarness.js";
import type { Customer } from "./support/paymentHarness.js";
import { createStaffKit, invitationToken, LOOPBACK, RP_ID } from "./support/staffKit.js";
import type { Staff } from "./support/staffKit.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

/**
 * Back-office (phase 9) : enrôlement et connexion du personnel par clé
 * WebAuthn, RBAC, réseau autorisé, décisions de conformité, double
 * validation exécutée par l'approbateur, journal d'audit chaîné.
 */

const harness = await createPaymentHarness();
const { owner, app, verifiedCustomer, totp, addRecipient, quote, createTransfer, transferStatus } = harness;

beforeAll(harness.setup);
beforeEach(harness.resetEach);
afterAll(harness.teardown);

const { invite, enroll, login, staff, as } = createStaffKit({ app, owner });

async function auditActions(targetId: string): Promise<string[]> {
  const result = await owner.query<{ action: string }>("SELECT action FROM audit.events WHERE target_id = $1 ORDER BY id", [targetId]);
  return result.rows.map((row) => row.action);
}

/** Transfert bloqué en revue par une correspondance de sanctions (homonyme). */
async function transferInReview(customer: Customer): Promise<string> {
  const recipient = await request(app)
    .post("/v1/recipients")
    .set("Authorization", `Bearer ${customer.token}`)
    .send({ country: "SN", currency: "XOF", firstName: "Amadou Karim", lastName: "Ousmane", account: { kind: "mobile_money", msisdn: `+22177${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`, operator: "wave" } });
  expect(recipient.status).toBe(201);
  const created = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId: recipient.body.id as string, purposeCode: "gift", totpCode: totp(customer) });
  expect(created.body.transfer.status).toBe("compliance_review");
  return created.body.transfer.id as string;
}

// =============================================================================
// Authentification du personnel
// =============================================================================

describe("enrôlement du personnel", () => {
  it("refuse une invitation inconnue, une passkey synchronisée et un mot de passe faible, puis active le compte", async () => {
    const unknown = await request(app).post("/v1/admin/auth/enrollment/options").send({ invitationToken: invitationToken() });
    expect(unknown.status).toBe(410);

    const invited = await invite(["support"]);
    const synced = await enroll(invited.token, `Phrase-de-passe-${randomUUID()}`, new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN), { backupEligible: true });
    expect(synced.status).toBe(400);
    const weak = await enroll(invited.token, "Court-1234", new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN));
    expect(weak.status).toBe(400);
    const wrongOrigin = await enroll(invited.token, `Phrase-de-passe-${randomUUID()}`, new SoftwareAuthenticator(RP_ID, "https://phishing.example"));
    expect(wrongOrigin.status).toBe(401);

    const authenticator = new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN);
    const ok = await enroll(invited.token, `Phrase-de-passe-${randomUUID()}`, authenticator);
    expect(ok.status).toBe(201);
    const account = await owner.query<{ status: string; keys: string }>(
      "SELECT u.status::text, (SELECT count(*) FROM backoffice.webauthn_credentials c WHERE c.admin_user_id = u.id)::text AS keys FROM backoffice.admin_users u WHERE u.id = $1",
      [invited.adminId],
    );
    expect(account.rows[0]).toEqual({ status: "active", keys: "1" });

    const replay = await request(app).post("/v1/admin/auth/enrollment/options").send({ invitationToken: invited.token });
    expect(replay.status).toBe(410);
    expect(await auditActions(invited.adminId)).toContain("backoffice.admin_enrolled");
  });
});

describe("connexion du personnel", () => {
  it("exige mot de passe puis clé, verrouille après cinq échecs et refuse un réseau non autorisé", async () => {
    const member = await staff(["support"]);
    const wrongKey = new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN);
    const stolenPassword = await login(member.email, member.password, wrongKey);
    expect(stolenPassword.status).toBe(401);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request(app).post("/v1/admin/auth/login").send({ email: member.email, password: "mauvais-mot-de-passe" });
      expect(failed.status).toBe(401);
    }
    // Verrouillé : même le bon mot de passe reçoit le refus générique (aucune indication de verrouillage).
    const locked = await request(app).post("/v1/admin/auth/login").send({ email: member.email, password: member.password });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe("INVALID_CREDENTIALS");
    const unknown = await request(app).post("/v1/admin/auth/login").send({ email: "inconnu@transfertplus.example", password: member.password });
    expect(locked.body).toEqual({ ...unknown.body, requestId: locked.body.requestId, instance: locked.body.instance });
    const lockAudit = await owner.query<{ reason: string }>(
      "SELECT metadata->>'reason' AS reason FROM audit.events WHERE target_id = $1 AND action = 'backoffice.login_failed' ORDER BY id DESC LIMIT 1",
      [member.adminId],
    );
    expect(lockAudit.rows[0]?.reason).toBe("locked");
    await owner.query("UPDATE backoffice.admin_users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1", [member.adminId]);

    await owner.query("UPDATE backoffice.admin_users SET allowed_ip_ranges = '{10.20.0.0/16}' WHERE id = $1", [member.adminId]);
    const outside = await request(app).post("/v1/admin/auth/login").send({ email: member.email, password: member.password });
    expect(outside.status).toBe(401);
    // Session déjà ouverte : coupée dès que le réseau n'est plus autorisé, y compris sur les routes d'autres modules.
    expect((await as(member).get("/v1/admin/me")).status).toBe(403);
    expect((await as(member).get("/v1/admin/ledger/trial-balance")).status).toBe(403);
    await owner.query("UPDATE backoffice.admin_users SET allowed_ip_ranges = $2::cidr[] WHERE id = $1", [member.adminId, LOOPBACK]);
    expect((await as(member).get("/v1/admin/me")).status).toBe(200);
  });

  it("renouvelle la session par rotation et la révoque à la réutilisation d'un jeton", async () => {
    const member = await staff(["support"]);
    const me = await as(member).get("/v1/admin/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ roles: ["support"], permissions: ["customers:read", "kyc:read", "transfers:read"] });

    const rotated = await request(app).post("/v1/admin/auth/token/refresh").send({ refreshToken: member.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(member.refreshToken);
    const reused = await request(app).post("/v1/admin/auth/token/refresh").send({ refreshToken: member.refreshToken });
    expect(reused.status).toBe(401);
    member.token = rotated.body.accessToken as string;
    expect((await as(member).get("/v1/admin/me")).status).toBe(401);
  });

  it("refuse un jeton client sur le back-office et ferme la session à la déconnexion", async () => {
    const customer = await verifiedCustomer();
    const customerCall = await request(app).get("/v1/admin/me").set("Authorization", `Bearer ${customer.token}`);
    expect(customerCall.status).toBe(401);

    const member = await staff(["support"]);
    expect((await as(member).post("/v1/admin/auth/logout")).status).toBe(204);
    expect((await as(member).get("/v1/admin/me")).status).toBe(401);
  });
});

// =============================================================================
// RBAC et clients
// =============================================================================

describe("habilitations et fiches clients", () => {
  it("limite le support à la consultation et trace le déchiffrement des données personnelles", async () => {
    const support = await staff(["support"]);
    const analyst = await staff(["risk_manager"]);
    const customer = await verifiedCustomer();

    const phone = `+3367${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
    await owner.query("UPDATE identity.users SET phone_bidx = $2 WHERE id = $1", [customer.userId, harness.indexer.compute("phone", phone)]);
    const found = await as(support).get(`/v1/admin/customers?q=${encodeURIComponent(phone)}`);
    expect(found.status).toBe(200);
    expect((found.body.items as { id: string }[]).map((item) => item.id)).toContain(customer.userId);
    const detail = await as(support).get(`/v1/admin/customers/${customer.userId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain("Aminata");

    expect((await as(support).post(`/v1/admin/customers/${customer.userId}/pii`, { justification: "Appel entrant du client" })).status).toBe(403);
    expect((await as(support).get("/v1/admin/aml/alerts")).status).toBe(403);

    const revealed = await as(analyst).post(`/v1/admin/customers/${customer.userId}/pii`, { justification: "Vérification d'identité demandée par la conformité" });
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ firstName: "Aminata", lastName: "Diop", phone: "+33612345678" });
    expect(await auditActions(customer.userId)).toContain("customers.pii_revealed");
  });

  it("suspend un client : ses sessions tombent immédiatement", async () => {
    const analyst = await staff(["risk_manager"]);
    const customer = await verifiedCustomer();
    const suspended = await as(analyst).post(`/v1/admin/customers/${customer.userId}/status`, { status: "suspended", reason: "Usurpation d'identité signalée" });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("suspended");
    const blocked = await request(app).get("/v1/transfers").set("Authorization", `Bearer ${customer.token}`);
    expect(blocked.status).toBe(401);
    const restored = await as(analyst).post(`/v1/admin/customers/${customer.userId}/status`, { status: "active", reason: "Identité confirmée par visioconférence" });
    expect(restored.body.status).toBe("active");
  });
});

// =============================================================================
// Conformité
// =============================================================================

describe("décisions de conformité", () => {
  it("ne libère un transfert en revue qu'après levée humaine de l'alerte bloquante", async () => {
    const support = await staff(["support"]);
    const analyst = await staff(["risk_manager"]);
    const customer = await verifiedCustomer();
    const transferId = await transferInReview(customer);

    const queue = await as(analyst).get("/v1/admin/aml/alerts?severity=critical");
    const alert = (queue.body.items as { id: string; transferId: string }[]).find((item) => item.transferId === transferId);
    expect(alert).toBeDefined();

    expect((await as(support).post(`/v1/admin/transfers/${transferId}/release`, { note: "Libération demandée par le client" })).status).toBe(403);
    const premature = await as(analyst).post(`/v1/admin/transfers/${transferId}/release`, { note: "Tentative avant levée de l'alerte" });
    expect(premature.status).toBe(409);

    expect((await as(analyst).post(`/v1/admin/aml/alerts/${alert!.id}/assign`)).body.status).toBe("under_review");
    const resolved = await as(analyst).post(`/v1/admin/aml/alerts/${alert!.id}/resolve`, { outcome: "false_positive", note: "Date de naissance et nationalité différentes de l'entrée OFAC" });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: "closed_false_positive", resolvedBy: analyst.adminId });
    expect(resolved.body.screening.status).toBe("false_positive");

    const released = await as(analyst).post(`/v1/admin/transfers/${transferId}/release`, { note: "Faux positif documenté, paiement autorisé" });
    expect(released.status).toBe(200);
    expect(await transferStatus(transferId)).toBe("payout_processing");
    expect(await auditActions(transferId)).toContain("transfers.released");
  });

  it("met en revue manuellement un transfert en attente de paiement", async () => {
    const analyst = await staff(["risk_manager"]);
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221770007777");
    // Prestataires indisponibles : le transfert attend en payout_pending.
    await owner.query("UPDATE payments.provider_health SET circuit_state = 'open', opened_at = now(), next_probe_at = now() + interval '1 hour' WHERE provider IN ('flutterwave', 'thunes')");
    const created = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    const transferId = created.body.transfer.id as string;
    expect(await transferStatus(transferId)).toBe("payout_pending");

    const held = await as(analyst).post(`/v1/admin/transfers/${transferId}/hold`, { reason: "Signalement de la banque émettrice" });
    expect(held.status).toBe(200);
    expect(held.body.status).toBe("compliance_review");
    expect(held.body.alerts).toEqual([expect.objectContaining({ rule: "MANUAL_REVIEW", status: "under_review" })]);
    expect((await as(analyst).post(`/v1/admin/transfers/${transferId}/hold`, { reason: "Deuxième mise en revue" })).status).toBe(409);
  });

  it("décide manuellement d'une vérification KYC : le niveau est relevé par la base", async () => {
    const support = await staff(["support"]);
    const analyst = await staff(["risk_manager"]);
    const customer = await verifiedCustomer({ tier: "tier_1" });
    const verification = await owner.connect();
    let verificationId: string;
    try {
      await verification.query("BEGIN");
      await verification.query("SELECT set_config('app.actor_type', 'provider', true), set_config('app.actor_id', 'onfido', true)");
      const created = await verification.query<{ id: string }>(
        "INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference) VALUES ($1, 'onfido', 'document_verification', 'tier_2', $2) RETURNING id",
        [customer.userId, `manual-${randomUUID()}`],
      );
      verificationId = created.rows[0]!.id;
      await verification.query("UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = $1", [verificationId]);
      await verification.query("UPDATE kyc.verifications SET status = 'in_review', provider_result = '{\"review\": \"internal\"}' WHERE id = $1", [verificationId]);
      await verification.query("COMMIT");
    } finally {
      verification.release();
    }

    const queue = await as(support).get("/v1/admin/kyc/reviews");
    expect((queue.body.items as { id: string }[]).map((item) => item.id)).toContain(verificationId);
    expect((await as(support).post(`/v1/admin/kyc/verifications/${verificationId}/decision`, { decision: "approve", note: "Pièce conforme après contrôle visuel" })).status).toBe(403);
    expect((await as(analyst).post(`/v1/admin/kyc/verifications/${verificationId}/decision`, { decision: "reject", note: "Pièce illisible" })).status).toBe(400);

    const decided = await as(analyst).post(`/v1/admin/kyc/verifications/${verificationId}/decision`, { decision: "approve", note: "Pièce conforme après contrôle visuel" });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("approved");
    expect((decided.body.history as unknown[]).at(-1)).toMatchObject({ to: "approved", actor: { type: "admin", id: analyst.adminId }, note: "Pièce conforme après contrôle visuel" });
    const tier = await owner.query<{ kyc_tier: string }>("SELECT kyc_tier::text FROM identity.users WHERE id = $1", [customer.userId]);
    expect(tier.rows[0]?.kyc_tier).toBe("tier_2");
  });

  it("instruit un dossier et dépose une déclaration de soupçon en double validation", async () => {
    const analystA = await staff(["risk_manager"]);
    const analystB = await staff(["risk_manager"]);
    const customer = await verifiedCustomer();
    const transferId = await transferInReview(customer);
    const alertId = (await owner.query<{ id: string }>("SELECT id FROM aml.alerts WHERE transfer_id = $1", [transferId])).rows[0]!.id;

    const opened = await as(analystA).post("/v1/admin/aml/cases", { userId: customer.userId, summary: "Bénéficiaire homonyme d'une personne sanctionnée", alertIds: [alertId] });
    expect(opened.status).toBe(201);
    const caseId = opened.body.id as string;
    expect(opened.body.alerts).toHaveLength(1);
    expect((await as(analystA).post(`/v1/admin/aml/cases/${caseId}/status`, { status: "investigating", note: "Demande de justificatifs au client" })).body.status).toBe("investigating");

    const requested = await as(analystA).post(`/v1/admin/aml/cases/${caseId}/sar-requests`, { sarReference: "TRACFIN-2026-0042", justification: "Faisceau d'indices concordants" });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ status: "pending", actionType: "file_sar", targetId: caseId });
    expect((await as(analystA).post(`/v1/admin/approvals/${requested.body.id as string}/approve`)).status).toBe(403);
    const approved = await as(analystB).post(`/v1/admin/approvals/${requested.body.id as string}/approve`, { note: "Déclaration validée" });
    expect(approved.status).toBe(200);
    expect(approved.body.approval.status).toBe("executed");
    const filed = await as(analystA).get(`/v1/admin/aml/cases/${caseId}`);
    expect(filed.body).toMatchObject({ status: "sar_filed", sarReference: "TRACFIN-2026-0042" });
  });
});

// =============================================================================
// Double validation
// =============================================================================

describe("double validation", () => {
  it("rembourse un transfert en revue sur décision de deux analystes", async () => {
    const analystA = await staff(["risk_manager"]);
    const analystB = await staff(["risk_manager"]);
    const support = await staff(["support"]);
    const customer = await verifiedCustomer();
    const before = await harness.balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId });
    const transferId = await transferInReview(customer);

    const requested = await as(analystA).post(`/v1/admin/transfers/${transferId}/refund-requests`, { reason: "Bénéficiaire non vérifiable", justification: "Le client ne peut pas justifier le lien avec le bénéficiaire" });
    expect(requested.status).toBe(202);
    const approvalId = requested.body.id as string;
    expect((await as(analystA).post(`/v1/admin/transfers/${transferId}/refund-requests`, { reason: "Demande en double", justification: "Deuxième demande identique" })).status).toBe(409);

    expect((await as(support).get("/v1/admin/approvals")).status).toBe(403);
    expect((await as(analystA).post(`/v1/admin/approvals/${approvalId}/approve`)).status).toBe(403);
    expect(await transferStatus(transferId)).toBe("compliance_review");

    const pending = await as(analystB).get("/v1/admin/approvals?status=pending");
    expect((pending.body.items as { id: string }[]).map((item) => item.id)).toContain(approvalId);
    const approved = await as(analystB).post(`/v1/admin/approvals/${approvalId}/approve`, { note: "Remboursement justifié" });
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({ status: "executed", decidedBy: { id: analystB.adminId } });
    expect(await transferStatus(transferId)).toBe("refunded");
    expect(await harness.balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(before);
    expect((await as(analystB).post(`/v1/admin/approvals/${approvalId}/approve`)).status).toBe(409);
  });

  it("gèle un compte du registre et refuse un ajustement déséquilibré", async () => {
    const adminA = await staff(["super_admin"]);
    const adminB = await staff(["super_admin"]);
    const customer = await verifiedCustomer();
    const account = (await owner.query<{ id: string }>("SELECT id FROM ledger.accounts WHERE owner_user_id = $1 AND account_type = 'customer_wallet' AND currency = 'EUR'", [customer.userId])).rows[0]!.id;

    const requested = await as(adminA).post(`/v1/admin/ledger/accounts/${account}/status-requests`, { status: "frozen", reason: "Réquisition judiciaire n° 2026-118", justification: "Réquisition reçue du parquet" });
    expect(requested.status).toBe(202);
    const approved = await as(adminB).post(`/v1/admin/approvals/${requested.body.id as string}/approve`);
    expect(approved.status).toBe(200);
    const status = await owner.query<{ status: string }>("SELECT status::text FROM ledger.accounts WHERE id = $1", [account]);
    expect(status.rows[0]?.status).toBe("frozen");

    const unbalanced = await as(adminA).post("/v1/admin/ledger/adjustment-requests", {
      description: "Correction d'un écart de rapprochement",
      justification: "Écart constaté au rapprochement du 3 octobre",
      entries: [
        { accountId: account, direction: "debit", amountMinor: "100", currency: "EUR" },
        { accountId: account, direction: "credit", amountMinor: "90", currency: "EUR" },
      ],
    });
    expect(unbalanced.status).toBe(400);
  });

  it("invite un membre du personnel : le lien d'enrôlement n'est remis qu'à l'approbateur", async () => {
    const adminA = await staff(["super_admin"]);
    const adminB = await staff(["super_admin"]);
    const email = `recrue-${randomUUID()}@transfertplus.example`;
    const tooBroad = await as(adminA).post("/v1/admin/staff/invitations", { email, fullName: "Nouvelle recrue", roles: ["support"], allowedIpRanges: ["0.0.0.0/0"], justification: "Renfort du support client" });
    expect(tooBroad.status).toBe(400);

    const requested = await as(adminA).post("/v1/admin/staff/invitations", { email, fullName: "Nouvelle recrue", roles: ["support"], allowedIpRanges: LOOPBACK, justification: "Renfort du support client" });
    expect(requested.status).toBe(202);
    expect(JSON.stringify(requested.body)).not.toContain("inv_");
    const approved = await as(adminB).post(`/v1/admin/approvals/${requested.body.id as string}/approve`);
    expect(approved.status).toBe(200);
    const link = new URL(approved.body.result.enrollmentUrl as string);
    expect(link.origin).toBe(ADMIN_ORIGIN);
    const token = new URLSearchParams(link.hash.slice(1)).get("invitation")!;

    const authenticator = new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN);
    const password = `Phrase-de-passe-${randomUUID()}`;
    expect((await enroll(token, password, authenticator)).status).toBe(201);
    const session = await login(email, password, authenticator);
    expect(session.status).toBe(200);

    const staffList = await as(adminA).get("/v1/admin/staff?status=active");
    expect((staffList.body.items as { email: string }[]).find((item) => item.email === email)).toMatchObject({ roles: ["support"], securityKeys: 1 });
    const restricted = await as(adminA).post(`/v1/admin/staff/${approved.body.result.adminId as string}/restriction`, { status: "disabled", reason: "Fin de mission du prestataire" });
    expect(restricted.body.status).toBe("disabled");
    const recruit = { token: session.body.accessToken as string } as Staff;
    expect((await as(recruit).get("/v1/admin/me")).status).toBe(401);
    expect((await as(adminA).post(`/v1/admin/staff/${adminA.adminId}/restriction`, { status: "suspended", reason: "Test d'auto-restriction" })).status).toBe(403);
  });
});

describe("journal d'audit", () => {
  it("expose les événements et vérifie l'intégrité de la chaîne", async () => {
    const auditor = await staff(["risk_manager"]);
    const events = await as(auditor).get(`/v1/admin/audit/events?actorId=${auditor.adminId}&limit=10`);
    expect(events.status).toBe(200);
    expect((events.body.items as { action: string }[]).map((item) => item.action)).toContain("backoffice.login_succeeded");
    const integrity = await as(auditor).get("/v1/admin/audit/integrity");
    expect(integrity.body).toMatchObject({ intact: true, problems: [] });
  });
});

describe("actions à double validation complémentaires", () => {
  it("attribue un rôle, restreint le réseau (sessions hors plage coupées) et réactive un compte suspendu", async () => {
    const adminA = await staff(["super_admin"]);
    const adminB = await staff(["super_admin"]);
    const target = await staff(["support"]);

    const roles = await as(adminA).post(`/v1/admin/staff/${target.adminId}/role-requests`, { roles: ["risk_manager"], justification: "Passage en équipe conformité" });
    expect(roles.status).toBe(202);
    expect((await as(adminB).post(`/v1/admin/approvals/${roles.body.id as string}/approve`)).status).toBe(200);
    expect((await as(target).get("/v1/admin/me")).body.roles).toEqual(["risk_manager", "support"]);

    const revoked = await as(adminA).delete(`/v1/admin/staff/${target.adminId}/roles/support`, { reason: "Rôle support devenu inutile" });
    expect(revoked.body.roles).toEqual(["risk_manager"]);
    expect((await as(adminA).delete(`/v1/admin/staff/${adminA.adminId}/roles/super_admin`, { reason: "Tentative sur soi-même" })).status).toBe(403);

    const network = await as(adminA).post(`/v1/admin/staff/${target.adminId}/network-requests`, { allowedIpRanges: ["10.30.0.0/16"], justification: "Accès limité au VPN du siège" });
    expect((await as(adminB).post(`/v1/admin/approvals/${network.body.id as string}/approve`)).status).toBe(200);
    expect((await as(target).get("/v1/admin/me")).status).toBe(401);
    await owner.query("UPDATE backoffice.admin_users SET allowed_ip_ranges = $2::cidr[] WHERE id = $1", [target.adminId, LOOPBACK]);

    expect((await as(adminA).post(`/v1/admin/staff/${target.adminId}/restriction`, { status: "suspended", reason: "Absence prolongée" })).body.status).toBe("suspended");
    const reactivation = await as(adminA).post(`/v1/admin/staff/${target.adminId}/reactivation-requests`, { justification: "Retour de congé confirmé" });
    expect(reactivation.status).toBe(202);
    const approved = await as(adminB).post(`/v1/admin/approvals/${reactivation.body.id as string}/approve`);
    expect(approved.body.result).toMatchObject({ status: "active" });
    expect((await login(target.email, target.password, target.authenticator)).status).toBe(200);
  });

  it("passe un ajustement équilibré puis le contre-passe, chacun approuvé par un second membre", async () => {
    const adminA = await staff(["super_admin"]);
    const adminB = await staff(["super_admin"]);
    const customer = await verifiedCustomer();
    const wallet = (await owner.query<{ id: string }>("SELECT id FROM ledger.accounts WHERE owner_user_id = $1 AND account_type = 'customer_wallet' AND currency = 'EUR'", [customer.userId])).rows[0]!.id;
    const fees = (await owner.query<{ id: string }>("SELECT id FROM ledger.accounts WHERE account_type = 'fee_revenue' AND currency = 'EUR'")).rows[0]!.id;
    const before = await harness.balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId });

    const adjustment = await as(adminA).post("/v1/admin/ledger/adjustment-requests", {
      description: "Frais de service omis lors d'un transfert",
      justification: "Écart constaté au rapprochement du 3 octobre",
      entries: [
        { accountId: wallet, direction: "debit", amountMinor: "500", currency: "EUR" },
        { accountId: fees, direction: "credit", amountMinor: "500", currency: "EUR" },
      ],
    });
    expect(adjustment.status).toBe(202);
    const executed = await as(adminB).post(`/v1/admin/approvals/${adjustment.body.id as string}/approve`);
    expect(executed.status).toBe(200);
    const journalId = executed.body.result.journalId as string;
    expect(await harness.balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(before - 500n);

    const reversal = await as(adminB).post(`/v1/admin/ledger/journals/${journalId}/reversal-requests`, { reason: "Frais déjà prélevés sur le transfert", justification: "Doublon du prélèvement automatique" });
    expect(reversal.status).toBe(202);
    const rejected = await as(adminA).post(`/v1/admin/approvals/${reversal.body.id as string}/reject`, { note: "Pas de doublon : deux transferts distincts" });
    expect(rejected.body).toMatchObject({ status: "rejected", decidedBy: { id: adminA.adminId } });
    expect((await as(adminA).post(`/v1/admin/approvals/${reversal.body.id as string}/approve`)).status).toBe(409);

    const again = await as(adminB).post(`/v1/admin/ledger/journals/${journalId}/reversal-requests`, { reason: "Frais déjà prélevés sur le transfert", justification: "Confirmation du doublon par la comptabilité" });
    expect((await as(adminA).post(`/v1/admin/approvals/${again.body.id as string}/approve`)).status).toBe(200);
    expect(await harness.balance({ type: "customer_wallet", currency: "EUR", userId: customer.userId })).toBe(before);
    expect((await as(adminB).post(`/v1/admin/ledger/journals/${journalId}/reversal-requests`, { reason: "Troisième tentative", justification: "Contre-passation déjà faite" })).status).toBe(409);
  });

  it("renouvelle l'invitation d'un compte encore invité", async () => {
    const admin = await staff(["super_admin"]);
    const pending = await invite(["support"]);
    const renewed = await as(admin).post(`/v1/admin/staff/${pending.adminId}/invitation`);
    expect(renewed.status).toBe(200);
    const token = new URLSearchParams(new URL(renewed.body.enrollmentUrl as string).hash.slice(1)).get("invitation")!;
    expect((await request(app).post("/v1/admin/auth/enrollment/options").send({ invitationToken: pending.token })).status).toBe(410);
    expect((await enroll(token, `Phrase-de-passe-${randomUUID()}`, new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN))).status).toBe(201);
  });
});
