import { randomBytes } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresPermissionChecker } from "../src/auth/permissions.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/transaction.js";
import { ChainAnchorJob } from "../src/jobs/anchor.job.js";
import { ReconciliationJob } from "../src/jobs/reconciliation.job.js";
import { JobScheduler } from "../src/jobs/scheduler.js";
import type { Job } from "../src/jobs/scheduler.js";
import { TimestampAuthorityClient } from "../src/lib/crypto/rfc3161.js";
import { toAppError } from "../src/lib/errors.js";
import { Money, parseCurrencyCode } from "../src/lib/money.js";
import { DeviceBindingService } from "../src/modules/auth/deviceBinding.service.js";
import { createLedgerModule } from "../src/modules/ledger/index.js";
import { assertBalanced, LedgerProgrammingError } from "../src/modules/ledger/ledger.service.js";
import type { Posting } from "../src/modules/ledger/ledger.service.js";
import {
  buildTestApp,
  buildTestConfig,
  createApiPool,
  createOwnerPool,
  createTestKeys,
  seedAdmin,
  seedCustomer,
  signAccessToken,
  silentLogger,
} from "./support/fixtures.js";
import type { SeededAdmin, SeededCustomer } from "./support/fixtures.js";
import { OpenSslTimestampAuthority } from "./support/tsa.js";

const EUR = parseCurrencyCode("EUR");
const XOF = parseCurrencyCode("XOF");

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const ledgerModule = createLedgerModule({
  pool: apiPool,
  verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
  sessions: new PostgresSessionValidator(apiPool),
  permissions: new PostgresPermissionChecker(apiPool),
  deviceBinding: new DeviceBindingService(apiPool),
});
const app = buildTestApp(config, {
  mountRoutes: (application) => {
    application.use(ledgerModule.router);
  },
});
const ledger = ledgerModule.ledger;

let customer: SeededCustomer;
let customerToken: string;

function unique(prefix: string): string {
  return `${prefix}:${randomBytes(8).toString("hex")}`;
}

/** Approvisionne un portefeuille client depuis le compte de règlement Stripe. */
async function fund(userId: string, amount: bigint, currency = EUR): Promise<string> {
  return withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, async (tx) => {
    const wallet = await ledger.customerAccount(tx, userId, "customer_wallet", currency);
    const settlement = await ledger.systemAccount(tx, "provider_settlement", currency, "stripe");
    return ledger.post(tx, {
      idempotencyKey: unique("test:funding"),
      journalType: "wallet_funding",
      postings: [
        { accountId: settlement, direction: "debit", money: Money.ofMinor(amount, currency) },
        { accountId: wallet, direction: "credit", money: Money.ofMinor(amount, currency) },
      ],
      description: "Rechargement par carte",
      actor: "system:tests",
      reference: { type: "payment_attempt", id: "6f1c2a8e-3b4d-4c5e-8f9a-0b1c2d3e4f5a" },
    });
  });
}

beforeAll(async () => {
  customer = await seedCustomer(owner);
  customerToken = await signAccessToken({ key: keys.customer, audience: "web", subject: customer.userId, sessionId: customer.webSessionId });
});

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("contrôle local d'équilibre", () => {
  const a = "6f1c2a8e-3b4d-4c5e-8f9a-0b1c2d3e4f5a";
  const b = "7a2b3c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d";
  const post = (account: string, direction: "debit" | "credit", amount: bigint, currency = EUR): Posting => ({
    accountId: account,
    direction,
    money: Money.ofMinor(amount, currency),
  });

  it("accepte un journal multi-devises équilibré par devise", () => {
    // (La cohérence devise ↔ compte est imposée par la base, pas ici.)
    expect(() =>
      assertBalanced([post(a, "debit", 100n), post(b, "credit", 100n), post("8b3c4d5e-6f7a-4b2c-8d9e-0f1a2b3c4d5e", "debit", 65_000n, XOF), post("9c4d5e6f-7a8b-4c3d-9e0f-1a2b3c4d5e6f", "credit", 65_000n, XOF)]),
    ).not.toThrow();
  });

  it.each([
    ["déséquilibré", [post(a, "debit", 100n), post(b, "credit", 99n)]],
    ["à une seule ligne", [post(a, "debit", 100n)]],
    ["débitant et créditant le même compte", [post(a, "debit", 100n), post(a, "credit", 100n)]],
  ])("refuse un journal %s", (_label, postings) => {
    expect(() => assertBalanced(postings)).toThrow(LedgerProgrammingError);
  });
});

describe("service du registre", () => {
  it("passe des écritures exactes jusqu'au plafond (aucune perte flottante)", async () => {
    const rich = await seedCustomer(owner);
    const amount = 999_999_999_999_999n;
    await withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, async (tx) => {
      const wallet = await ledger.customerAccount(tx, rich.userId, "customer_wallet", EUR);
      const equity = await ledger.systemAccount(tx, "equity", EUR);
      await ledger.post(tx, {
        idempotencyKey: unique("test:precision"),
        journalType: "capital_injection",
        postings: [
          { accountId: equity, direction: "debit", money: Money.ofMinor(amount, EUR) },
          { accountId: wallet, direction: "credit", money: Money.ofMinor(amount, EUR) },
        ],
        description: "Test de précision",
        actor: "system:tests",
      });
    });
    const balance = await owner.query<{ available: string }>("SELECT available::text FROM ledger.customer_balances WHERE user_id = $1", [rich.userId]);
    expect(balance.rows[0]?.available).toBe("999999999999999");
  });

  it("est idempotent et contre-passe une seule fois", async () => {
    const user = await seedCustomer(owner);
    const key = unique("test:idem");
    const postOnce = () =>
      withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, async (tx) => {
        const wallet = await ledger.customerAccount(tx, user.userId, "customer_wallet", EUR);
        const settlement = await ledger.systemAccount(tx, "provider_settlement", EUR, "stripe");
        return ledger.post(tx, {
          idempotencyKey: key,
          journalType: "wallet_funding",
          postings: [
            { accountId: settlement, direction: "debit", money: Money.ofMinor(5_000n, EUR) },
            { accountId: wallet, direction: "credit", money: Money.ofMinor(5_000n, EUR) },
          ],
          description: "Rechargement",
          actor: "system:tests",
        });
      });
    const first = await postOnce();
    expect(await postOnce()).toBe(first);
    const reversal = await withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, (tx) =>
      ledger.reverse(tx, { journalId: first, idempotencyKey: unique("test:rev"), reason: "Paiement contesté par la banque", actor: "system:tests" }),
    );
    expect(reversal).not.toBe(first);
    const second = await withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, (tx) =>
      ledger.reverse(tx, { journalId: first, idempotencyKey: unique("test:rev"), reason: "Deuxième tentative", actor: "system:tests" }),
    ).catch((error: unknown) => toAppError(error));
    expect(second).toMatchObject({ code: "INVALID_REVERSAL" });
  });

  it("traduit un découvert en INSUFFICIENT_FUNDS", async () => {
    const poor = await seedCustomer(owner);
    const error = await withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, async (tx) => {
      const wallet = await ledger.customerAccount(tx, poor.userId, "customer_wallet", EUR);
      const fees = await ledger.systemAccount(tx, "fee_revenue", EUR);
      await ledger.post(tx, {
        idempotencyKey: unique("test:overdraft"),
        journalType: "transfer_fee",
        postings: [
          { accountId: wallet, direction: "debit", money: Money.ofMinor(1n, EUR) },
          { accountId: fees, direction: "credit", money: Money.ofMinor(1n, EUR) },
        ],
        description: "Frais",
        actor: "system:tests",
      });
    }).catch((caught: unknown) => toAppError(caught));
    expect(error).toMatchObject({ code: "INSUFFICIENT_FUNDS", httpStatus: 422 });
  });

  it("impose la présence ou l'absence de prestataire selon le type de compte", async () => {
    await expect(withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, (tx) => ledger.systemAccount(tx, "provider_settlement", EUR))).rejects.toThrow(
      LedgerProgrammingError,
    );
    await expect(withTransaction(apiPool, { actor: { type: "system", id: "tests" } }, (tx) => ledger.systemAccount(tx, "fee_revenue", EUR, "stripe"))).rejects.toThrow(
      LedgerProgrammingError,
    );
  });
});

describe("portefeuilles clients", () => {
  const auth = () => ({ Authorization: `Bearer ${customerToken}` });

  it("ouvre un portefeuille dans une devise proposée, de façon idempotente", async () => {
    const first = await request(app).post("/v1/wallets").set(auth()).send({ currency: "EUR" });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ currency: "EUR", minorUnits: 2, available: { amount: "0", currency: "EUR" }, held: { amount: "0", currency: "EUR" } });
    expect((await request(app).post("/v1/wallets").set(auth()).send({ currency: "EUR" })).status).toBe(201);
    const accounts = await owner.query("SELECT 1 FROM ledger.accounts WHERE owner_user_id = $1 AND currency = 'EUR'", [customer.userId]);
    expect(accounts.rowCount).toBe(2);
  });

  it("refuse une devise fermée", async () => {
    const response = await request(app).post("/v1/wallets").set(auth()).send({ currency: "CHF" });
    expect(response.status).toBe(422);
  });

  it("affiche le solde puis un relevé paginé du plus récent au plus ancien", async () => {
    for (const amount of [1_000n, 2_000n, 3_000n, 4_000n, 5_000n]) await fund(customer.userId, amount);
    const wallets = await request(app).get("/v1/wallets").set(auth());
    expect(wallets.body.wallets).toContainEqual({ currency: "EUR", minorUnits: 2, available: { amount: "15000", currency: "EUR" }, held: { amount: "0", currency: "EUR" } });

    const firstPage = await request(app).get("/v1/wallets/EUR/statement?limit=2").set(auth());
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.entries).toHaveLength(2);
    expect(firstPage.body.entries[0]).toMatchObject({ type: "wallet_funding", direction: "in", amount: { amount: "5000", currency: "EUR" }, balanceAfter: { amount: "15000", currency: "EUR" } });
    expect(firstPage.body.entries[1].balanceAfter.amount).toBe("10000");
    expect(firstPage.body.nextCursor).toBe(firstPage.body.entries[1].sequence);

    const secondPage = await request(app).get(`/v1/wallets/EUR/statement?limit=2&before=${firstPage.body.nextCursor as string}`).set(auth());
    expect((secondPage.body.entries as { amount: { amount: string } }[]).map((entry) => entry.amount.amount)).toEqual(["3000", "2000"]);
    const lastPage = await request(app).get(`/v1/wallets/EUR/statement?limit=2&before=${secondPage.body.nextCursor as string}`).set(auth());
    expect(lastPage.body.entries).toHaveLength(1);
    expect(lastPage.body.nextCursor).toBeNull();
  });

  it("isole les portefeuilles entre clients", async () => {
    const other = await seedCustomer(owner);
    const otherToken = await signAccessToken({ key: keys.customer, audience: "web", subject: other.userId, sessionId: other.webSessionId });
    const wallets = await request(app).get("/v1/wallets").set("Authorization", `Bearer ${otherToken}`);
    expect(wallets.body.wallets).toEqual([]);
    expect((await request(app).get("/v1/wallets/EUR/statement").set("Authorization", `Bearer ${otherToken}`)).status).toBe(404);
  });

  it("valide les paramètres et exige l'authentification", async () => {
    expect((await request(app).get("/v1/wallets")).status).toBe(401);
    expect((await request(app).get("/v1/wallets/eur/statement").set(auth())).status).toBe(400);
    expect((await request(app).get("/v1/wallets/EUR/statement?limit=500").set(auth())).status).toBe(400);
    expect((await request(app).get("/v1/wallets/EUR/statement?before=-1").set(auth())).status).toBe(400);
  });
});

describe("consultation du registre par le personnel", () => {
  let support: SeededAdmin;
  let risk: SeededAdmin;
  let journalId: string;

  beforeAll(async () => {
    support = await seedAdmin(owner, "support");
    risk = await seedAdmin(owner, "risk_manager");
    journalId = await fund(customer.userId, 777n);
  });

  const tokenFor = (admin: SeededAdmin) =>
    signAccessToken({ key: keys.admin, audience: "admin", subject: admin.adminId, sessionId: admin.sessionId, assuranceLevel: 2 });

  it("refuse le personnel sans la permission ledger:read", async () => {
    const response = await request(app).get(`/v1/admin/ledger/journals/${journalId}`).set("Authorization", `Bearer ${await tokenFor(support)}`);
    expect(response.status).toBe(403);
  });

  it("refuse un jeton client", async () => {
    expect((await request(app).get(`/v1/admin/ledger/journals/${journalId}`).set("Authorization", `Bearer ${customerToken}`)).status).toBe(401);
  });

  it("expose un journal, son empreinte et ses écritures", async () => {
    const response = await request(app).get(`/v1/admin/ledger/journals/${journalId}`).set("Authorization", `Bearer ${await tokenFor(risk)}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: journalId, type: "wallet_funding", reference: { type: "payment_attempt" } });
    expect(response.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body.entries).toHaveLength(2);
    const accountId = response.body.entries[0].accountId as string;
    const account = await request(app).get(`/v1/admin/ledger/accounts/${accountId}`).set("Authorization", `Bearer ${await tokenFor(risk)}`);
    expect(account.status).toBe(200);
    expect(account.body.type).toBe("provider_settlement");
    const entries = await request(app).get(`/v1/admin/ledger/accounts/${accountId}/entries?limit=1`).set("Authorization", `Bearer ${await tokenFor(risk)}`);
    expect(entries.body.entries).toHaveLength(1);
  });

  it("expose la balance générale équilibrée", async () => {
    const response = await request(app).get("/v1/admin/ledger/trial-balance").set("Authorization", `Bearer ${await tokenFor(risk)}`);
    expect(response.status).toBe(200);
    expect(response.body.currencies.length).toBeGreaterThan(0);
    for (const currency of response.body.currencies as { balanced: boolean }[]) expect(currency.balanced).toBe(true);
  });

  it("renvoie 404 pour un journal inconnu", async () => {
    const response = await request(app).get("/v1/admin/ledger/journals/00000000-0000-4000-8000-000000000000").set("Authorization", `Bearer ${await tokenFor(risk)}`);
    expect(response.status).toBe(404);
  });
});

describe("rapprochement d'intégrité", () => {
  const job = new ReconciliationJob(apiPool, silentLogger, "test-worker", 60_000);

  it("vérifie complètement puis de façon incrémentale", async () => {
    await fund(customer.userId, 1_234n);
    const full = await job.reconcile("full");
    expect(full).toMatchObject({ scope: "full", status: "healthy", verifiedFromSeq: 1n });
    await fund(customer.userId, 4_321n);
    const incremental = await job.reconcile();
    expect(incremental.scope).toBe("incremental");
    expect(incremental.status).toBe("healthy");
    expect(incremental.verifiedFromSeq).toBe(full.verifiedToSeq + 1n);
    expect(incremental.verifiedToSeq).toBeGreaterThan(full.verifiedToSeq);
  });

  it("détecte une falsification (même par un superutilisateur) et alerte", async () => {
    const tamperedJournal = await fund(customer.userId, 2_500n);
    const restore = async (delta: number): Promise<void> => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query("UPDATE ledger.entries SET amount = amount + $2 WHERE journal_id = $1", [tamperedJournal, delta]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await restore(100);
    try {
      const result = await job.reconcile("full");
      expect(result.status).toBe("anomalies");
      expect(result.problems.map((problem) => problem.check)).toEqual(expect.arrayContaining(["chain", "balances"]));
      const alert = await owner.query("SELECT payload FROM integrations.outbox WHERE dedup_key = $1", [`ledger.integrity_breach:${result.runId}`]);
      expect(alert.rowCount).toBe(1);
      const stored = await owner.query<{ status: string }>("SELECT status FROM ledger.reconciliation_runs WHERE id = $1", [result.runId]);
      expect(stored.rows[0]?.status).toBe("anomalies");
      await expect(owner.query("UPDATE ledger.reconciliation_runs SET status = 'healthy', problems = '[]' WHERE id = $1", [result.runId])).rejects.toThrow(/figé/);
    } finally {
      await restore(-100);
    }
    expect((await job.reconcile("full")).status).toBe("healthy");
  });
});

describe("ancrage RFC 3161", () => {
  it("ancre le dernier état vérifié avec un jeton contrôlable par OpenSSL", async () => {
    const tsa = new OpenSslTimestampAuthority();
    const reconciliation = new ReconciliationJob(apiPool, silentLogger, "test-worker", 60_000);
    await fund(customer.userId, 9_999n);
    const verified = await reconciliation.reconcile("full");
    expect(verified.status).toBe("healthy");
    await fund(customer.userId, 1n); // journal non encore vérifié : ne doit pas être ancré

    const anchorJob = new ChainAnchorJob(apiPool, silentLogger, new TimestampAuthorityClient("https://tsa.test/", [tsa.rootCertificate], tsa.fetch()), "test-tsa", 60_000);
    const result = await anchorJob.anchor();
    expect(result).toEqual({ status: "anchored", seq: verified.verifiedToSeq });
    expect(await anchorJob.anchor()).toEqual({ status: "already_anchored", seq: verified.verifiedToSeq });

    const anchor = await owner.query<{ hash: Buffer; evidence: Buffer; external_reference: string }>(
      "SELECT hash, evidence, external_reference FROM ledger.chain_anchors WHERE anchor_target = 'test-tsa' ORDER BY id DESC LIMIT 1",
    );
    const row = anchor.rows[0]!;
    expect(row.external_reference).toMatch(/^serial=[0-9A-F]+;genTime=/);
    expect(tsa.opensslVerify(row.evidence, row.hash.toString("hex"))).toContain("Verification: OK");
  });
});

describe("planificateur", () => {
  it("n'exécute jamais une tâche en parallèle, même entre deux instances", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowJob: Job = {
      name: `test-job-${randomBytes(4).toString("hex")}`,
      intervalMs: 3_600_000,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 200));
        concurrent -= 1;
      },
    };
    const first = new JobScheduler(apiPool, silentLogger, [slowJob]);
    const second = new JobScheduler(apiPool, silentLogger, [slowJob]);
    const outcomes = await Promise.all([first.runOnce(slowJob.name), second.runOnce(slowJob.name), first.runOnce(slowJob.name)]);
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
    expect(outcomes).toEqual(expect.arrayContaining(["skipped_locked", "skipped_running"]));
    expect(maxConcurrent).toBe(1);
    expect(await second.runOnce(slowJob.name)).toBe("completed");
    await Promise.all([first.stop(), second.stop()]);
  });

  it("isole l'échec d'une tâche", async () => {
    const failing: Job = { name: `failing-${randomBytes(4).toString("hex")}`, intervalMs: 3_600_000, run: () => Promise.reject(new Error("panne")) };
    const scheduler = new JobScheduler(apiPool, silentLogger, [failing]);
    expect(await scheduler.runOnce(failing.name)).toBe("failed");
    await scheduler.stop();
  });
});
