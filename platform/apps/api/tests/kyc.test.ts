import { createHmac, randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { BlindIndexer } from "../src/lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider, fieldContext } from "../src/lib/crypto/fieldEncryption.js";
import { WebhookSignatureError } from "../src/lib/crypto/webhookSignature.js";
import { createMemoryRateLimiter } from "../src/middlewares/rateLimit.js";
import { DeviceBindingService } from "../src/modules/auth/deviceBinding.service.js";
import { configuredKycProviders, createKycModule } from "../src/modules/kyc/index.js";
import { extractOnfidoIdentity, OnfidoClient } from "../src/modules/kyc/providers/onfido.client.js";
import { SmileIdClient, smileSignature, verifySmileCallback, verifySmileSignature } from "../src/modules/kyc/providers/smileId.client.js";
import { ageOn, KycProviderError, matchDeclaredIdentity, nameTokens, normalizeDocumentNumber, parseIsoDate } from "../src/modules/kyc/providers/types.js";
import { WebhookInbox } from "../src/modules/webhooks/webhookInbox.js";
import { buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, seedCustomer, signAccessToken, silentLogger } from "./support/fixtures.js";

// -----------------------------------------------------------------------------
// Faux prestataires (API HTTP en mémoire) : les vrais clients sont exercés.
// -----------------------------------------------------------------------------

const ONFIDO_TOKEN = `api_sandbox.${"a".repeat(24)}`;
const ONFIDO_WEBHOOK_TOKEN = "w".repeat(40);
const WORKFLOW_DOCUMENT = "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90";
const WORKFLOW_ADDRESS = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SMILE_PARTNER = "2343";
const SMILE_KEY = "k".repeat(36);

interface FakeRun {
  id: string;
  applicant_id: string;
  workflow_id: string;
  status: string;
  output: Record<string, unknown> | null;
  reasons: string[];
}

interface SmileJob {
  job_complete: boolean;
  job_success: boolean;
  result: Record<string, unknown> | string;
  tamperSignature?: boolean;
}

class FakeProviders {
  readonly applicants = new Map<string, Record<string, unknown>>();
  readonly runs = new Map<string, FakeRun>();
  readonly smileJobs = new Map<string, SmileJob>();
  readonly calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  failOnfidoReads = 0;
  private counter = 0;

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body, headers });
    if (url.startsWith("https://api.eu.onfido.com/v3.6/")) return Promise.resolve(this.onfido(method, url.slice("https://api.eu.onfido.com/v3.6".length), headers, body));
    if (url.startsWith("https://testapi.smileidentity.com/v1/")) return Promise.resolve(this.smile(url.slice("https://testapi.smileidentity.com/v1".length), body));
    return Promise.resolve(json(404, { error: "unknown host" }));
  };

  private onfido(method: string, path: string, headers: Record<string, string>, body: unknown): Response {
    if (headers["authorization"] !== `Token token=${ONFIDO_TOKEN}`) return json(401, { error: { type: "authorization_error" } });
    if (method === "POST" && path === "/applicants") {
      const id = `applicant-${(this.counter += 1)}`;
      this.applicants.set(id, body as Record<string, unknown>);
      return json(201, { id, ...(body as Record<string, unknown>) });
    }
    if (method === "POST" && path === "/workflow_runs") {
      const request = body as { workflow_id: string; applicant_id: string };
      if (!this.applicants.has(request.applicant_id)) return json(422, { error: { type: "validation_error" } });
      const id = `run-${(this.counter += 1)}`;
      this.runs.set(id, { id, applicant_id: request.applicant_id, workflow_id: request.workflow_id, status: "awaiting_input", output: null, reasons: [] });
      return json(201, { id, applicant_id: request.applicant_id, workflow_id: request.workflow_id, status: "awaiting_input", sdk_token: `sdk-token-${id}` });
    }
    const runMatch = /^\/workflow_runs\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && runMatch !== null) {
      if (this.failOnfidoReads > 0) {
        this.failOnfidoReads -= 1;
        return json(503, { error: { type: "service_unavailable" } });
      }
      const run = this.runs.get(runMatch[1]!);
      return run === undefined ? json(404, { error: { type: "resource_not_found" } }) : json(200, run);
    }
    return json(404, { error: { type: "resource_not_found" } });
  }

  private smile(path: string, body: unknown): Response {
    const request = body as Record<string, string>;
    if (request["partner_id"] !== SMILE_PARTNER || !verifySmileSignature(SMILE_KEY, SMILE_PARTNER, request["timestamp"] ?? "", request["signature"] ?? "")) {
      return json(401, { error: "invalid signature" });
    }
    if (path === "/token") return json(200, { token: `web-token-${request["job_id"] ?? ""}` });
    if (path === "/job_status") {
      const job = this.smileJobs.get(request["job_id"] ?? "") ?? { job_complete: false, job_success: false, result: "No results" };
      const timestamp = new Date().toISOString();
      const signature = job.tamperSignature === true ? smileSignature("other-key-0000000000", SMILE_PARTNER, timestamp) : smileSignature(SMILE_KEY, SMILE_PARTNER, timestamp);
      return json(200, { timestamp, signature, job_complete: job.job_complete, job_success: job.job_success, code: "2302", result: job.result });
    }
    return json(404, {});
  }

  setRun(runId: string, status: string, output: Record<string, unknown> | null = null, reasons: string[] = []): void {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`run inconnu ${runId}`);
    Object.assign(run, { status, output, reasons });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const passportOutput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  first_name: "AÏSSATOU MARIAM",
  last_name: "DIALLO",
  date_of_birth: "1990-04-12",
  document_type: "passport",
  issuing_country: "FRA",
  document_numbers: [{ type: "document_number", value: "12AB 34567" }],
  ...overrides,
});

const declared = { firstName: "Aïssatou", lastName: "Diallo", dateOfBirth: "1990-04-12" };

function onfidoSignature(body: string): string {
  return createHmac("sha256", ONFIDO_WEBHOOK_TOKEN).update(body).digest("hex");
}

function onfidoEvent(runId: string, status = "approved"): string {
  return JSON.stringify({
    payload: {
      resource_type: "workflow_run",
      action: "workflow_run.completed",
      object: { id: runId, status, completed_at_iso8601: new Date().toISOString(), href: `https://api.eu.onfido.com/v3.6/workflow_runs/${runId}` },
    },
  });
}

// -----------------------------------------------------------------------------
// Tests unitaires
// -----------------------------------------------------------------------------

describe("primitives KYC", () => {
  it("calcule la signature Smile ID selon le schéma officiel (horodatage ‖ partner_id ‖ sid_request)", () => {
    const timestamp = "2026-10-03T12:00:00.000Z";
    const expected = createHmac("sha256", SMILE_KEY).update(`${timestamp}${SMILE_PARTNER}sid_request`).digest("base64");
    expect(smileSignature(SMILE_KEY, SMILE_PARTNER, timestamp)).toBe(expected);
    expect(verifySmileSignature(SMILE_KEY, SMILE_PARTNER, timestamp, expected)).toBe(true);
    expect(verifySmileSignature(SMILE_KEY, "9999", timestamp, expected)).toBe(false);
    expect(verifySmileSignature(SMILE_KEY, SMILE_PARTNER, "1791000000", expected)).toBe(false);
    expect(verifySmileSignature(SMILE_KEY, SMILE_PARTNER, timestamp, "pas*du*base64")).toBe(false);
  });

  it("authentifie un rappel Smile ID et refuse signature absente, invalide ou périmée", () => {
    const now = Date.parse("2026-10-03T12:00:00.000Z");
    const timestamp = new Date(now - 30_000).toISOString();
    const body = { timestamp, signature: smileSignature(SMILE_KEY, SMILE_PARTNER, timestamp), ResultCode: "0810", PartnerParams: { job_id: "job-1", user_id: "user-1", job_type: 1 } };
    const verified = verifySmileCallback({ body, partnerId: SMILE_PARTNER, apiKey: SMILE_KEY, toleranceSeconds: 600, nowMs: now });
    expect(verified).toMatchObject({ jobId: "job-1", userId: "user-1", resultCode: "0810" });

    const reasonOf = (candidate: unknown, nowMs = now): string => {
      try {
        verifySmileCallback({ body: candidate, partnerId: SMILE_PARTNER, apiKey: SMILE_KEY, toleranceSeconds: 600, nowMs });
        return "accepted";
      } catch (error: unknown) {
        return error instanceof WebhookSignatureError ? error.reason : "other";
      }
    };
    expect(reasonOf({ PartnerParams: body.PartnerParams })).toBe("missing_signature");
    expect(reasonOf({ ...body, signature: smileSignature("autre-cle-000000000", SMILE_PARTNER, timestamp) })).toBe("invalid_signature");
    expect(reasonOf({ ...body, PartnerParams: undefined })).toBe("malformed_payload");
    expect(reasonOf(body, now + 3_600_000)).toBe("timestamp_out_of_tolerance");
  });

  it("compare les noms sans tenir compte des accents, de la casse ni des prénoms secondaires", () => {
    expect(nameTokens("Aïssatou N'Diaye-Ba")).toEqual(["aissatou", "n", "diaye", "ba"]);
    const read = { documentType: "passport" as const, issuingCountry: "FR", documentNumber: "X", fullName: "AISSATOU MARIAM DIALLO", dateOfBirth: "1990-04-12" };
    expect(matchDeclaredIdentity(declared, read, true)).toEqual({ match: true });
    expect(matchDeclaredIdentity({ ...declared, lastName: "Diop" }, read, true)).toEqual({ match: false, reason: "name_mismatch" });
    expect(matchDeclaredIdentity(declared, { ...read, dateOfBirth: "1990-04-13" }, true)).toEqual({ match: false, reason: "date_of_birth_mismatch" });
    expect(matchDeclaredIdentity(declared, { ...read, dateOfBirth: null }, true)).toEqual({ match: null, reason: "date_of_birth_unavailable" });
    expect(matchDeclaredIdentity(declared, { ...read, dateOfBirth: null }, false)).toEqual({ match: true });
    expect(matchDeclaredIdentity(declared, null, true)).toEqual({ match: null, reason: "name_unavailable" });
  });

  it("valide dates, âges et numéros de pièce", () => {
    expect(parseIsoDate("2000-02-29")).toBe("2000-02-29");
    expect(parseIsoDate("2001-02-29")).toBeNull();
    expect(parseIsoDate("12/04/1990")).toBeNull();
    expect(ageOn("2008-10-04", new Date("2026-10-03T12:00:00Z"))).toBe(17);
    expect(ageOn("2008-10-03", new Date("2026-10-03T12:00:00Z"))).toBe(18);
    expect(normalizeDocumentNumber(" 12ab-345.67 ")).toBe("12AB34567");
    expect(normalizeDocumentNumber("12")).toBeNull();
  });

  it("lit la sortie d'un workflow Onfido (numéros multiples, type de pièce, pays alpha-3)", () => {
    expect(extractOnfidoIdentity(passportOutput())).toEqual({
      documentType: "passport",
      issuingCountry: "FRA",
      documentNumber: "12AB 34567",
      fullName: "AÏSSATOU MARIAM DIALLO",
      dateOfBirth: "1990-04-12",
    });
    expect(extractOnfidoIdentity({ document_type: "national_identity_card", document_number: "AB123", first_name: "A", last_name: "B" })?.documentType).toBe("national_id");
    expect(extractOnfidoIdentity({ date_of_birth: "1990-02-31" })).toBeNull();
    expect(extractOnfidoIdentity(["not", "an", "object"])).toBeNull();
  });

  it("client Onfido : authentification, réutilisation du dossier et correspondance des statuts", async () => {
    const fake = new FakeProviders();
    const client = new OnfidoClient({ apiToken: ONFIDO_TOKEN, baseUrl: "https://api.eu.onfido.com/v3.6", workflows: { document_verification: WORKFLOW_DOCUMENT } }, fake.fetch);
    expect(client.supports("document_verification")).toBe(true);
    expect(client.supports("proof_of_address")).toBe(false);

    const base = { verificationId: randomUUID(), userId: randomUUID(), jobType: "document_verification" as const, channel: "mobile" as const, declared, countryOfResidenceAlpha3: "FRA" };
    const first = await client.startSession({ ...base, existingApplicantReference: null });
    expect(first.launch).toMatchObject({ provider: "onfido", sdkToken: `sdk-token-${first.providerReference}` });
    expect(fake.calls[0]).toMatchObject({ method: "POST", body: { first_name: "Aïssatou", last_name: "Diallo", dob: "1990-04-12", location: { country_of_residence: "FRA" } } });
    expect(fake.calls[1]?.body).toMatchObject({ workflow_id: WORKFLOW_DOCUMENT, applicant_id: first.applicantReference });

    const second = await client.startSession({ ...base, existingApplicantReference: first.applicantReference });
    expect(second.applicantReference).toBe(first.applicantReference);
    expect(fake.applicants.size).toBe(1);

    const outcome = (status: string) => {
      fake.setRun(first.providerReference, status, passportOutput(), status === "declined" ? ["document_expired"] : []);
      return client.fetchOutcome({ verificationId: base.verificationId, userId: base.userId, providerReference: first.providerReference, jobType: "document_verification" });
    };
    expect((await outcome("approved")).kind).toBe("approved");
    expect(await outcome("declined")).toMatchObject({ kind: "rejected", summary: { reasons: ["document_expired"] } });
    expect((await outcome("review")).kind).toBe("manual_review");
    expect((await outcome("error")).kind).toBe("manual_review");
    expect((await outcome("abandoned")).kind).toBe("abandoned");
    expect((await outcome("awaiting_input")).kind).toBe("pending");
    await expect(outcome("teleported")).rejects.toBeInstanceOf(KycProviderError);

    const unauthorized = new OnfidoClient({ apiToken: `api_sandbox.${"b".repeat(24)}`, baseUrl: "https://api.eu.onfido.com/v3.6", workflows: { document_verification: WORKFLOW_DOCUMENT } }, fake.fetch);
    await expect(unauthorized.startSession({ ...base, existingApplicantReference: null })).rejects.toMatchObject({ retryable: false });
  });

  it("client Smile ID : paramètres SDK signés, jeton web, réponse job_status authentifiée", async () => {
    const fake = new FakeProviders();
    const client = new SmileIdClient(
      { partnerId: SMILE_PARTNER, apiKey: SMILE_KEY, environment: "sandbox", baseUrl: "https://testapi.smileidentity.com/v1", callbackUrl: "https://api.transfertplus.test/v1/webhooks/smile-id" },
      fake.fetch,
    );
    const verificationId = randomUUID();
    const userId = randomUUID();
    const base = { verificationId, userId, jobType: "biometric_kyc" as const, declared, countryOfResidenceAlpha3: "NGA", existingApplicantReference: null };

    const mobile = await client.startSession({ ...base, channel: "mobile" });
    expect(fake.calls).toHaveLength(0);
    expect(mobile.launch).toMatchObject({ provider: "smile_id", jobId: verificationId, userId, jobType: 1, product: "biometric_kyc", webToken: null });
    if (mobile.launch.provider !== "smile_id") throw new Error("lancement Smile ID attendu");
    expect(verifySmileSignature(SMILE_KEY, SMILE_PARTNER, mobile.launch.timestamp, mobile.launch.signature)).toBe(true);

    const web = await client.startSession({ ...base, channel: "web" });
    expect(web.launch).toMatchObject({ webToken: `web-token-${verificationId}` });

    const request = { verificationId, userId, providerReference: verificationId, jobType: "biometric_kyc" as const };
    expect((await client.fetchOutcome(request)).kind).toBe("pending");

    const result = { ResultCode: "0810", ResultText: "Enroll User", PartnerParams: { job_id: verificationId, user_id: userId, job_type: 1 }, FullName: "DIALLO AISSATOU", DOB: "1990-04-12", IDNumber: "A1234567", IDType: "PASSPORT", Country: "NG", Actions: { Liveness_Check: "Passed", Selfie_To_ID_Authority_Compare: "Completed" } };
    fake.smileJobs.set(verificationId, { job_complete: false, job_success: false, result: { ...result, ResultCode: "0812" } });
    expect((await client.fetchOutcome(request)).kind).toBe("provider_review");
    fake.smileJobs.set(verificationId, { job_complete: true, job_success: true, result });
    expect(await client.fetchOutcome(request)).toMatchObject({ kind: "approved", identity: { documentType: "passport", issuingCountry: "NG", documentNumber: "A1234567", fullName: "DIALLO AISSATOU" } });
    fake.smileJobs.set(verificationId, { job_complete: true, job_success: false, result: { ...result, ResultCode: "0811", Actions: { Liveness_Check: "Failed" } } });
    expect(await client.fetchOutcome(request)).toMatchObject({ kind: "rejected", summary: { reasons: ["Liveness_Check:Failed"] } });
    fake.smileJobs.set(verificationId, { job_complete: true, job_success: true, result: { ...result, PartnerParams: { job_id: verificationId, user_id: "someone-else" } } });
    await expect(client.fetchOutcome(request)).rejects.toThrow(/ne correspond pas/);
    fake.smileJobs.set(verificationId, { job_complete: true, job_success: true, result, tamperSignature: true });
    await expect(client.fetchOutcome(request)).rejects.toThrow(/signature/);
  });
});

// -----------------------------------------------------------------------------
// Parcours complets (API + base)
// -----------------------------------------------------------------------------

const keys = await createTestKeys();
const config = buildTestConfig(keys, {
  ONFIDO_API_TOKEN: ONFIDO_TOKEN,
  ONFIDO_WEBHOOK_TOKEN,
  ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: WORKFLOW_DOCUMENT,
  ONFIDO_WORKFLOW_PROOF_OF_ADDRESS: WORKFLOW_ADDRESS,
  SMILE_ID_PARTNER_ID: SMILE_PARTNER,
  SMILE_ID_API_KEY: SMILE_KEY,
  SMILE_ID_CALLBACK_URL: "https://api.transfertplus.test/v1/webhooks/smile-id",
  KYC_MAX_ATTEMPTS_PER_30_DAYS: "3",
});
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const fake = new FakeProviders();
const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
const inbox = new WebhookInbox(apiPool, silentLogger);
const kycModule = createKycModule({
  config,
  pool: apiPool,
  logger: silentLogger,
  verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
  sessions: new PostgresSessionValidator(apiPool),
  deviceBinding: new DeviceBindingService(apiPool),
  encryptor,
  indexer: new BlindIndexer(config.crypto.blindIndexKey),
  inbox,
  limiters: { startBySubject: createMemoryRateLimiter({ keyPrefix: "kyc-start", points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }) },
  providers: configuredKycProviders(config, fake.fetch),
  webhookProcessing: "inline",
});
const app = buildTestApp(config, {
  mountRoutes: (application) => {
    application.use(kycModule.router);
  },
});

interface Customer {
  readonly userId: string;
  readonly token: string;
}

async function newCustomer(countryOfResidence = "FR"): Promise<Customer> {
  const seeded = await seedCustomer(owner, { countryOfResidence });
  return { userId: seeded.userId, token: await signAccessToken({ key: keys.customer, audience: "web", subject: seeded.userId, sessionId: seeded.webSessionId }) };
}

async function startVerification(customer: Customer, body: Record<string, unknown>) {
  return request(app).post("/v1/kyc/verifications").set("Authorization", `Bearer ${customer.token}`).send(body);
}

async function postOnfido(body: string, signature = onfidoSignature(body)) {
  return request(app).post("/v1/webhooks/onfido").set("Content-Type", "application/json").set("X-SHA2-Signature", signature).send(body);
}

async function verificationRow(id: string) {
  const result = await owner.query<{ status: string; rejection_reasons: string[]; provider_result: Record<string, unknown>; expires_at: Date | null }>(
    "SELECT status::text, rejection_reasons, provider_result, expires_at FROM kyc.verifications WHERE id = $1",
    [id],
  );
  return result.rows[0]!;
}

async function tierOf(userId: string): Promise<string> {
  const result = await owner.query<{ kyc_tier: string }>("SELECT kyc_tier::text FROM identity.users WHERE id = $1", [userId]);
  return result.rows[0]!.kyc_tier;
}

/** Recule les horodatages (hors triggers) pour simuler le passage du temps. */
async function ageVerification(id: string, assignments: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE kyc.verifications SET ${assignments} WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

/** Ouvre une vérification de niveau 1 Onfido et renvoie son identifiant et son run. */
async function openOnfidoVerification(customer: Customer, withIdentity = true): Promise<{ readonly id: string; readonly runId: string }> {
  const response = await startVerification(customer, { tier: "tier_1", ...(withIdentity ? { declaredIdentity: declared } : {}) });
  expect(response.status).toBe(201);
  return { id: response.body.verification.id as string, runId: response.body.launch.workflowRunId as string };
}

beforeAll(async () => {
  await owner.query("SELECT 1");
});

beforeEach(() => {
  fake.failOnfidoReads = 0;
});

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("parcours KYC Onfido", () => {
  it("expose le niveau, les plafonds et la prochaine étape", async () => {
    const customer = await newCustomer();
    const response = await request(app).get("/v1/kyc").set("Authorization", `Bearer ${customer.token}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tier: "tier_0",
      limits: { singleTransferMax: { amount: "0", currency: "USD" } },
      nextTier: "tier_1",
      declaredIdentity: false,
      attemptsRemaining: 3,
      activeVerification: null,
      verifications: [],
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/v1/kyc")).status).toBe(401);
  });

  it("exige une identité déclarée valide et majeure", async () => {
    const customer = await newCustomer();
    expect((await startVerification(customer, { tier: "tier_1" })).status).toBe(422);
    expect((await startVerification(customer, { tier: "tier_1", declaredIdentity: { ...declared, dateOfBirth: "2015-01-01" } })).status).toBe(422);
    expect((await startVerification(customer, { tier: "tier_1", declaredIdentity: { ...declared, dateOfBirth: "1990-02-30" } })).status).toBe(400);
    expect((await startVerification(customer, { tier: "tier_1", declaredIdentity: { ...declared, firstName: "<script>" } })).status).toBe(400);
    expect((await startVerification(customer, { tier: "tier_2", declaredIdentity: declared })).status).toBe(409);
    expect((await startVerification(customer, { tier: "tier_3" })).status).toBe(400);

    // Session mobile : requête non signée par l'appareil refusée.
    const seeded = await seedCustomer(owner);
    const mobileToken = await signAccessToken({ key: keys.customer, audience: "mobile", subject: seeded.userId, sessionId: seeded.mobileSessionId, deviceId: seeded.deviceId, assuranceLevel: 2 });
    const unsigned = await request(app).post("/v1/kyc/verifications").set("Authorization", `Bearer ${mobileToken}`).send({ tier: "tier_1", declaredIdentity: declared });
    expect(unsigned.status).toBe(401);
    expect((await owner.query("SELECT 1 FROM kyc.verifications WHERE user_id = $1", [seeded.userId])).rowCount).toBe(0);
  });

  it("approuve une vérification concordante et accorde le niveau par la base", async () => {
    const customer = await newCustomer();
    const response = await startVerification(customer, { tier: "tier_1", declaredIdentity: declared });
    expect(response.status).toBe(201);
    expect(response.body.verification).toMatchObject({ tier: "tier_1", provider: "onfido", jobType: "document_verification", status: "pending_submission", nextAction: "complete_capture" });
    const { id } = response.body.verification as { id: string };
    const runId = response.body.launch.workflowRunId as string;
    expect(response.body.launch).toEqual({ provider: "onfido", sdkToken: `sdk-token-${runId}`, workflowRunId: runId });

    // Identité déclarée chiffrée (jamais en clair en base).
    const stored = await owner.query<{ first_name_enc: Buffer }>("SELECT first_name_enc FROM identity.users WHERE id = $1", [customer.userId]);
    expect(stored.rows[0]!.first_name_enc.includes(Buffer.from("Aïssatou"))).toBe(false);
    expect(await encryptor.decrypt(stored.rows[0]!.first_name_enc, fieldContext("identity", "users", "first_name", customer.userId))).toBe("Aïssatou");

    const submitted = await request(app).post(`/v1/kyc/verifications/${id}/submitted`).set("Authorization", `Bearer ${customer.token}`);
    expect(submitted.body).toMatchObject({ status: "submitted", nextAction: "wait" });

    fake.setRun(runId, "approved", passportOutput());
    const approvalEvent = onfidoEvent(runId);
    const webhook = await postOnfido(approvalEvent);
    expect(webhook.status).toBe(200);
    expect(webhook.body).toEqual({ received: true });

    const row = await verificationRow(id);
    expect(row.status).toBe("approved");
    expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now() + 700 * 86_400_000);
    expect(await tierOf(customer.userId)).toBe("tier_1");

    const evidence = await owner.query<{ issuing_country: string; document_type: string; declared_identity_match: boolean; document_number_bidx: Buffer | null; full_name_enc: Buffer }>(
      "SELECT issuing_country, document_type::text, declared_identity_match, document_number_bidx, full_name_enc FROM kyc.identity_evidence WHERE verification_id = $1",
      [id],
    );
    expect(evidence.rows[0]).toMatchObject({ issuing_country: "FR", document_type: "passport", declared_identity_match: true });
    expect(evidence.rows[0]!.document_number_bidx).toHaveLength(32);
    expect(await encryptor.decrypt(evidence.rows[0]!.full_name_enc, fieldContext("kyc", "identity_evidence", "full_name", id))).toBe("AÏSSATOU MARIAM DIALLO");

    const outbox = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_id = $1", [id]);
    expect(outbox.rows.map((r) => r.event_type)).toEqual(["kyc.verification_approved"]);

    // Webhook stocké minimisé, traité ; un renvoi identique est un doublon sans effet.
    const events = await owner.query<{ status: string; payload: Record<string, unknown> }>(
      "SELECT status::text, payload FROM integrations.webhook_events WHERE source = 'onfido' AND payload->>'object_id' = $1",
      [runId],
    );
    expect(events.rows).toEqual([{ status: "processed", payload: expect.objectContaining({ action: "workflow_run.completed", object_id: runId }) as unknown }]);
    expect((await postOnfido(approvalEvent)).status).toBe(200);
    expect((await owner.query("SELECT 1 FROM integrations.webhook_events WHERE payload->>'object_id' = $1", [runId])).rowCount).toBe(1);
    // Un nouvel événement (autre horodatage) est enregistré mais sans effet sur une vérification terminée.
    expect((await postOnfido(onfidoEvent(runId))).status).toBe(200);
    expect((await verificationRow(id)).status).toBe("approved");

    const overview = await request(app).get("/v1/kyc").set("Authorization", `Bearer ${customer.token}`);
    expect(overview.body).toMatchObject({ tier: "tier_1", nextTier: "tier_2", declaredIdentity: true, limits: { singleTransferMax: { amount: "50000", currency: "USD" } } });

    // Identité figée après octroi ; niveau 1 déjà acquis.
    expect((await startVerification(customer, { tier: "tier_2", declaredIdentity: declared })).status).toBe(409);
    expect((await startVerification(customer, { tier: "tier_1" })).status).toBe(409);

    // Niveau 2 : preuve de domicile (sans date de naissance) concordante.
    const address = await startVerification(customer, { tier: "tier_2" });
    expect(address.status).toBe(201);
    expect(address.body.verification).toMatchObject({ jobType: "proof_of_address" });
    const addressRun = address.body.launch.workflowRunId as string;
    expect(fake.runs.get(addressRun)?.workflow_id).toBe(WORKFLOW_ADDRESS);
    expect(fake.applicants.size).toBeGreaterThan(0);
    expect(fake.runs.get(addressRun)?.applicant_id).toBe(fake.runs.get(runId)?.applicant_id);
    fake.setRun(addressRun, "approved", { first_name: "Aissatou", last_name: "Diallo" });
    await postOnfido(onfidoEvent(addressRun));
    expect(await tierOf(customer.userId)).toBe("tier_2");
  });

  it("refuse les webhooks non authentifiés et les trace", async () => {
    const before = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM integrations.webhook_rejections");
    const body = onfidoEvent("run-forged");
    expect((await postOnfido(body, onfidoSignature(`${body} `))).status).toBe(401);
    expect((await request(app).post("/v1/webhooks/onfido").set("Content-Type", "application/json").send(body)).status).toBe(401);
    expect((await postOnfido(body, "zz-not-hex")).status).toBe(401);
    const malformed = JSON.stringify({ payload: { action: "workflow_run.completed" } });
    expect((await postOnfido(malformed)).status).toBe(400);

    const rejections = await owner.query<{ reason: string; body_size: number }>(
      "SELECT reason::text, body_size FROM integrations.webhook_rejections ORDER BY id DESC LIMIT 4",
    );
    expect(rejections.rows.map((r) => r.reason).sort()).toEqual(["invalid_signature", "invalid_signature", "malformed_payload", "missing_signature"]);
    const after = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM integrations.webhook_rejections");
    expect(Number(after.rows[0]!.count) - Number(before.rows[0]!.count)).toBe(4);
    expect((await owner.query("SELECT 1 FROM integrations.webhook_events WHERE payload->>'object_id' = 'run-forged'")).rowCount).toBe(0);

    // Un événement authentique d'un autre type est accepté puis ignoré.
    const other = JSON.stringify({ payload: { resource_type: "check", action: "check.completed", object: { id: "chk-1", status: "complete" } } });
    expect((await postOnfido(other)).status).toBe(200);
    const stored = await owner.query<{ status: string }>("SELECT status::text FROM integrations.webhook_events WHERE payload->>'object_id' = 'chk-1'");
    expect(stored.rows[0]?.status).toBe("ignored");
  });

  it("ne lit jamais le résultat dans le webhook : seul l'état du run chez Onfido compte", async () => {
    const customer = await newCustomer();
    const { id, runId } = await openOnfidoVerification(customer);
    // Le webhook annonce « approved » mais le run est toujours en cours de capture.
    expect((await postOnfido(onfidoEvent(runId, "approved"))).status).toBe(200);
    expect((await verificationRow(id)).status).toBe("pending_submission");
    expect(await tierOf(customer.userId)).toBe("tier_0");
  });

  it("met en revue manuelle une pièce déjà utilisée par un autre client", async () => {
    const first = await newCustomer();
    const firstRun = await openOnfidoVerification(first);
    const sharedPassport = passportOutput({ document_numbers: [{ type: "document_number", value: "99ZZ00001" }] });
    fake.setRun(firstRun.runId, "approved", sharedPassport);
    await postOnfido(onfidoEvent(firstRun.runId));
    expect(await tierOf(first.userId)).toBe("tier_1");

    const second = await newCustomer();
    const secondRun = await openOnfidoVerification(second);
    fake.setRun(secondRun.runId, "approved", sharedPassport);
    await postOnfido(onfidoEvent(secondRun.runId));

    const row = await verificationRow(secondRun.id);
    expect(row.status).toBe("in_review");
    expect(row.rejection_reasons).toEqual(["document_already_used"]);
    expect(row.provider_result).toMatchObject({ review: "internal", status: "approved" });
    expect(await tierOf(second.userId)).toBe("tier_0");
    const outbox = await owner.query<{ event_type: string; payload: { reasons: string[] } }>("SELECT event_type, payload FROM integrations.outbox WHERE aggregate_id = $1", [secondRun.id]);
    expect(outbox.rows).toEqual([{ event_type: "kyc.review_required", payload: expect.objectContaining({ reasons: ["document_already_used"] }) as unknown }]);

    // En revue interne : plus aucune mise à jour automatique (décision humaine, phase 9).
    expect((await postOnfido(onfidoEvent(secondRun.runId))).status).toBe(200);
    expect((await verificationRow(secondRun.id)).status).toBe("in_review");
    const view = await request(app).get(`/v1/kyc/verifications/${secondRun.id}`).set("Authorization", `Bearer ${second.token}`);
    expect(view.body).toMatchObject({ status: "in_review", nextAction: "wait" });
    expect(JSON.stringify(view.body)).not.toContain("document_already_used");
  });

  it("met en revue manuelle une identité discordante ou un mineur, rejette un refus du prestataire", async () => {
    const mismatch = await newCustomer();
    const mismatchRun = await openOnfidoVerification(mismatch);
    fake.setRun(mismatchRun.runId, "approved", passportOutput({ last_name: "DIOP", document_numbers: [{ type: "document_number", value: "77MM00001" }] }));
    await postOnfido(onfidoEvent(mismatchRun.runId));
    expect(await verificationRow(mismatchRun.id)).toMatchObject({ status: "in_review", rejection_reasons: ["name_mismatch"] });

    const minor = await newCustomer();
    const minorRun = await openOnfidoVerification(minor);
    fake.setRun(minorRun.runId, "approved", passportOutput({ date_of_birth: "2012-01-01", document_numbers: [{ type: "document_number", value: "77MM00002" }] }));
    await postOnfido(onfidoEvent(minorRun.runId));
    expect(await verificationRow(minorRun.id)).toMatchObject({ status: "in_review", rejection_reasons: ["date_of_birth_mismatch", "underage"] });

    const noData = await newCustomer();
    const noDataRun = await openOnfidoVerification(noData);
    fake.setRun(noDataRun.runId, "approved", null);
    await postOnfido(onfidoEvent(noDataRun.runId));
    expect(await verificationRow(noDataRun.id)).toMatchObject({ status: "in_review", rejection_reasons: ["identity_not_extracted"] });

    const declinedCustomer = await newCustomer();
    const declinedRun = await openOnfidoVerification(declinedCustomer);
    fake.setRun(declinedRun.runId, "declined", passportOutput({ document_numbers: [{ type: "document_number", value: "77MM00003" }] }), ["document_expired"]);
    await postOnfido(onfidoEvent(declinedRun.runId));
    expect(await verificationRow(declinedRun.id)).toMatchObject({ status: "rejected", rejection_reasons: ["document_expired"] });
    const view = await request(app).get(`/v1/kyc/verifications/${declinedRun.id}`).set("Authorization", `Bearer ${declinedCustomer.token}`);
    expect(view.body).toMatchObject({ status: "rejected", nextAction: "retry" });
    expect(await tierOf(declinedCustomer.userId)).toBe("tier_0");
  });

  it("remplace une session non terminée, refuse une seconde vérification soumise, limite les tentatives", async () => {
    const customer = await newCustomer();
    const first = await openOnfidoVerification(customer);
    const second = await openOnfidoVerification(customer, false);
    expect(second.id).not.toBe(first.id);
    expect((await verificationRow(first.id)).status).toBe("expired");

    await request(app).post(`/v1/kyc/verifications/${second.id}/submitted`).set("Authorization", `Bearer ${customer.token}`);
    expect((await startVerification(customer, { tier: "tier_1" })).status).toBe(409);

    // Trois refus sur 30 jours : quatrième tentative refusée.
    fake.setRun(second.runId, "declined", null, ["selfie_mismatch"]);
    await postOnfido(onfidoEvent(second.runId));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = await openOnfidoVerification(customer, false);
      fake.setRun(next.runId, "declined", null, ["selfie_mismatch"]);
      await postOnfido(onfidoEvent(next.runId));
    }
    const overview = await request(app).get("/v1/kyc").set("Authorization", `Bearer ${customer.token}`);
    expect(overview.body).toMatchObject({ attemptsRemaining: 0 });
    expect(overview.body.verifications[0]).toMatchObject({ status: "rejected", nextAction: "contact_support" });
    const exhausted = await startVerification(customer, { tier: "tier_1" });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers["retry-after"]).toBe("86400");

    // Autre client : la vérification d'autrui est introuvable.
    const stranger = await newCustomer();
    expect((await request(app).get(`/v1/kyc/verifications/${second.id}`).set("Authorization", `Bearer ${stranger.token}`)).status).toBe(404);
    expect((await request(app).post(`/v1/kyc/verifications/${second.id}/submitted`).set("Authorization", `Bearer ${stranger.token}`)).status).toBe(404);
  });

  it("reprend un webhook dont le traitement a échoué (prestataire indisponible)", async () => {
    const customer = await newCustomer();
    const { id, runId } = await openOnfidoVerification(customer);
    fake.setRun(runId, "approved", passportOutput({ document_numbers: [{ type: "document_number", value: "55RT00001" }] }));
    fake.failOnfidoReads = 1;
    expect((await postOnfido(onfidoEvent(runId))).status).toBe(200);
    const event = await owner.query<{ id: string; status: string; attempts: number; last_error: string }>(
      "SELECT id, status::text, attempts, last_error FROM integrations.webhook_events WHERE payload->>'object_id' = $1",
      [runId],
    );
    expect(event.rows[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(event.rows[0]!.last_error).toContain("HTTP 503");
    expect((await verificationRow(id)).status).toBe("pending_submission");

    // Délai de reprise non écoulé : rien ne se passe.
    expect(await inbox.processPending(10)).toEqual({ processed: 0, failed: 0 });
    await owner.query("UPDATE integrations.webhook_events SET locked_until = now() - interval '1 second' WHERE id = $1", [event.rows[0]!.id]);
    expect(await inbox.processPending(10)).toEqual({ processed: 1, failed: 0 });
    expect((await verificationRow(id)).status).toBe("approved");
  });

  it("synchronise sans webhook, expire les sessions abandonnées et les approbations échues", async () => {
    const customer = await newCustomer();
    const { id, runId } = await openOnfidoVerification(customer);
    fake.setRun(runId, "processing");
    await ageVerification(id, "updated_at = now() - interval '10 minutes'");
    await kycModule.service.synchronize(100);
    expect((await verificationRow(id)).status).toBe("submitted");

    fake.setRun(runId, "approved", passportOutput({ document_numbers: [{ type: "document_number", value: "66SY00001" }] }));
    await ageVerification(id, "updated_at = now() - interval '10 minutes'");
    await kycModule.service.synchronize(100);
    expect((await verificationRow(id)).status).toBe("approved");
    expect(await tierOf(customer.userId)).toBe("tier_1");

    // Approbation échue : le niveau est retiré par la base.
    await ageVerification(id, "expires_at = now() - interval '1 minute'");
    await kycModule.service.synchronize(100);
    expect((await verificationRow(id)).status).toBe("expired");
    expect(await tierOf(customer.userId)).toBe("tier_0");

    // Session jamais terminée au-delà du délai : expirée, sans compter comme tentative.
    const idle = await newCustomer();
    const idleRun = await openOnfidoVerification(idle);
    await ageVerification(idleRun.id, "created_at = now() - interval '25 hours', updated_at = now() - interval '25 hours'");
    await kycModule.service.synchronize(100);
    expect((await verificationRow(idleRun.id)).status).toBe("expired");
  });
});

describe("parcours KYC Smile ID", () => {
  async function postSmile(body: Record<string, unknown>) {
    return request(app).post("/v1/webhooks/smile-id").set("Content-Type", "application/json").send(JSON.stringify(body));
  }

  function callback(jobId: string, userId: string, timestamp = new Date().toISOString()): Record<string, unknown> {
    return {
      timestamp,
      signature: smileSignature(SMILE_KEY, SMILE_PARTNER, timestamp),
      ResultCode: "0810",
      ResultText: "Enroll User",
      SmileJobID: "0000000042",
      PartnerParams: { job_id: jobId, user_id: userId, job_type: 1 },
      // Données nominatives envoyées par Smile ID : jamais conservées telles quelles.
      FullName: "DIALLO AISSATOU",
      DOB: "1990-04-12",
    };
  }

  it("route un résident nigérian vers Smile ID et applique le résultat relu par job_status", async () => {
    const customer = await newCustomer("NG");
    const response = await startVerification(customer, { tier: "tier_1", declaredIdentity: declared });
    expect(response.status).toBe(201);
    expect(response.body.verification).toMatchObject({ provider: "smile_id", jobType: "biometric_kyc" });
    const id = response.body.verification.id as string;
    expect(response.body.launch).toMatchObject({ provider: "smile_id", partnerId: SMILE_PARTNER, jobId: id, userId: customer.userId, jobType: 1, webToken: `web-token-${id}` });

    fake.smileJobs.set(id, {
      job_complete: true,
      job_success: true,
      result: { ResultCode: "0810", ResultText: "Enroll User", PartnerParams: { job_id: id, user_id: customer.userId, job_type: 1 }, FullName: "DIALLO AISSATOU", DOB: "1990-04-12", IDNumber: "A00000001", IDType: "NIN_V2", Country: "NG" },
    });
    expect((await postSmile(callback(id, customer.userId))).status).toBe(200);
    expect((await verificationRow(id)).status).toBe("approved");
    expect(await tierOf(customer.userId)).toBe("tier_1");
    const evidence = await owner.query<{ document_type: string; issuing_country: string }>(
      "SELECT document_type::text, issuing_country FROM kyc.identity_evidence WHERE verification_id = $1",
      [id],
    );
    expect(evidence.rows[0]).toEqual({ document_type: "national_id", issuing_country: "NG" });
    const stored = await owner.query<{ payload: Record<string, unknown>; signed_at: Date }>("SELECT payload, signed_at FROM integrations.webhook_events WHERE source = 'smile_id' AND payload->>'job_id' = $1", [id]);
    expect(stored.rows[0]!.payload).toEqual({ job_id: id, user_id: customer.userId, result_code: "0810", smile_job_id: "0000000042" });
    expect(JSON.stringify(stored.rows[0]!.payload)).not.toContain("DIALLO");
  });

  it("refuse un rappel Smile ID périmé, falsifié ou destiné à un autre client", async () => {
    const customer = await newCustomer("NG");
    const response = await startVerification(customer, { tier: "tier_1", declaredIdentity: declared });
    const id = response.body.verification.id as string;

    expect((await postSmile(callback(id, customer.userId, new Date(Date.now() - 3_600_000).toISOString()))).status).toBe(401);
    expect((await postSmile({ ...callback(id, customer.userId), signature: smileSignature("cle-volee-0000000000", SMILE_PARTNER, new Date().toISOString()) })).status).toBe(401);
    const reasons = await owner.query<{ reason: string }>("SELECT reason::text FROM integrations.webhook_rejections WHERE source = 'smile_id' ORDER BY id DESC LIMIT 2");
    expect(reasons.rows.map((r) => r.reason).sort()).toEqual(["invalid_signature", "timestamp_out_of_tolerance"]);

    // Signature valide mais job d'un autre client : ignoré.
    const other = await newCustomer("NG");
    expect((await postSmile(callback(id, other.userId))).status).toBe(200);
    expect((await verificationRow(id)).status).toBe("pending_submission");
    const event = await owner.query<{ status: string }>("SELECT status::text FROM integrations.webhook_events WHERE source = 'smile_id' AND payload->>'user_id' = $1", [other.userId]);
    expect(event.rows[0]?.status).toBe("ignored");
  });

  it("place en revue chez le prestataire un résultat provisoire puis applique la décision finale", async () => {
    const customer = await newCustomer("NG");
    const response = await startVerification(customer, { tier: "tier_1", declaredIdentity: declared });
    const id = response.body.verification.id as string;
    const result = { ResultCode: "0812", ResultText: "Provisional", PartnerParams: { job_id: id, user_id: customer.userId, job_type: 1 } };
    fake.smileJobs.set(id, { job_complete: false, job_success: false, result });
    await postSmile(callback(id, customer.userId));
    expect(await verificationRow(id)).toMatchObject({ status: "in_review", provider_result: expect.objectContaining({ review: "provider" }) as unknown });

    fake.smileJobs.set(id, { job_complete: true, job_success: false, result: { ...result, ResultCode: "0813", Actions: { Liveness_Check: "Possible Spoof" } } });
    await postSmile({ ...callback(id, customer.userId), ResultCode: "0813" });
    expect(await verificationRow(id)).toMatchObject({ status: "rejected", rejection_reasons: ["Liveness_Check:Possible Spoof"] });
  });
});
