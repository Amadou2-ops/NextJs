import { createHmac, randomBytes, randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { BlindIndexer } from "../src/lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider, fieldContext } from "../src/lib/crypto/fieldEncryption.js";
import { DecimalLiteral, stringifyWithDecimals } from "../src/lib/json.js";
import { decimalStringToMinor, decimalStringToMinorCeil, minorToDecimalString } from "../src/lib/money.js";
import { createMemoryRateLimiter } from "../src/middlewares/rateLimit.js";
import { DeviceBindingService } from "../src/modules/auth/deviceBinding.service.js";
import { MfaService } from "../src/modules/auth/mfa.service.js";
import { generateTotpSecret, hotp, timeStep } from "../src/modules/auth/totp.js";
import { CircuitBreaker } from "../src/modules/payments/circuitBreaker.js";
import { encodeStripeForm } from "../src/modules/payments/providers/stripe.client.js";
import { PaymentProviderError } from "../src/modules/payments/providers/types.js";
import { normalizeIban } from "../src/modules/recipients/recipients.service.js";
import { configuredPaymentProviders, createTransfersModule } from "../src/modules/transfers/index.js";
import { WebhookInbox } from "../src/modules/webhooks/webhookInbox.js";
import { TestDevice } from "./support/device.js";
import { buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, grantKycTier, seedCustomer, signAccessToken, silentLogger } from "./support/fixtures.js";

// =============================================================================
// Faux prestataires (API HTTP en mémoire) : les vrais clients sont exercés.
// =============================================================================

const STRIPE_SECRET = `sk_test_${"a".repeat(24)}`;
const STRIPE_PUBLISHABLE = `pk_test_${"b".repeat(24)}`;
const STRIPE_WEBHOOK_SECRET = `whsec_${"c".repeat(32)}`;
const FLW_SECRET = `FLWSECK_TEST-${"d".repeat(32)}-X`;
const FLW_HASH = "flutterwave-webhook-hash-0123456789";
const THUNES_BASE = "https://api-mt.thunes.test";
const THUNES_KEY = "thunes-key-01";
const THUNES_SECRET = "thunes-secret-0123456789";

interface StripeIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  client_secret: string;
  amount_received: number;
  fee: number;
}

interface FlwPayin {
  id: number;
  amount: string;
  currency: string;
  status: string;
  app_fee: string;
}

interface FlwTransfer {
  id: number;
  amount: string;
  currency: string;
  status: string;
  fee: string;
  reference: string;
  account_bank: string;
  account_number: string;
}

interface ThunesTransaction {
  id: number;
  external_id: string;
  status_class: string;
  destination: { amount: string; currency: string };
  confirmed: boolean;
}

class FakePaymentProviders {
  readonly intents = new Map<string, StripeIntent>();
  readonly stripeIdempotency = new Map<string, unknown>();
  readonly refunds = new Map<string, { id: string; status: string; amount: number; currency: string; payment_intent: string }>();
  readonly flwPayins = new Map<string, FlwPayin>();
  readonly flwTransfers = new Map<number, FlwTransfer>();
  readonly thunes = new Map<string, ThunesTransaction>();
  readonly calls: { url: string; method: string; body: string }[] = [];
  flutterwaveTransfers: "accept" | "reject" | "unavailable" = "accept";
  thunesQuotations: "accept" | "reject" = "accept";
  refundStatus = "succeeded";
  private counter = 1000;

  reset(): void {
    this.flutterwaveTransfers = "accept";
    this.thunesQuotations = "accept";
    this.refundStatus = "succeeded";
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? init.body : "";
    this.calls.push({ url, method, body });
    if (url.startsWith("https://api.stripe.com/v1")) return Promise.resolve(this.stripe(method, url.slice("https://api.stripe.com/v1".length), headers, body));
    if (url.startsWith("https://api.flutterwave.com/v3")) return Promise.resolve(this.flutterwave(method, url.slice("https://api.flutterwave.com/v3".length), headers, body));
    if (url.startsWith(THUNES_BASE)) return Promise.resolve(this.thunesApi(method, url.slice(THUNES_BASE.length), headers, body));
    return Promise.resolve(raw(404, "{}"));
  };

  private stripe(method: string, path: string, headers: Record<string, string>, body: string): Response {
    if (headers["authorization"] !== `Bearer ${STRIPE_SECRET}` || headers["stripe-version"] === undefined) return raw(401, JSON.stringify({ error: { type: "invalid_request_error", code: "unauthorized" } }));
    const form = new URLSearchParams(body);
    const key = headers["idempotency-key"];
    if (method === "POST" && key !== undefined && this.stripeIdempotency.has(key)) return raw(200, JSON.stringify(this.stripeIdempotency.get(key)));
    const remember = (payload: unknown): Response => {
      if (key !== undefined) this.stripeIdempotency.set(key, payload);
      return raw(200, JSON.stringify(payload));
    };
    if (method === "POST" && path === "/payment_intents") {
      const id = `pi_${(this.counter += 1).toString()}`;
      const intent: StripeIntent = {
        id,
        amount: Number(form.get("amount")),
        currency: form.get("currency") ?? "",
        status: "requires_payment_method",
        client_secret: `${id}_secret_${randomBytes(4).toString("hex")}`,
        amount_received: 0,
        fee: 0,
      };
      this.intents.set(id, intent);
      return remember(this.intentJson(intent, false));
    }
    const intentMatch = /^\/payment_intents\/(pi_\d+)(\/cancel)?(\?.*)?$/.exec(path);
    if (intentMatch !== null) {
      const intent = this.intents.get(intentMatch[1] ?? "");
      if (intent === undefined) return raw(404, JSON.stringify({ error: { code: "resource_missing" } }));
      if (intentMatch[2] === "/cancel") {
        if (intent.status === "succeeded") return raw(400, JSON.stringify({ error: { code: "payment_intent_unexpected_state" } }));
        intent.status = "canceled";
        return remember(this.intentJson(intent, false));
      }
      return raw(200, JSON.stringify(this.intentJson(intent, (intentMatch[3] ?? "").includes("balance_transaction"))));
    }
    if (method === "POST" && path === "/refunds") {
      const intent = this.intents.get(form.get("payment_intent") ?? "");
      if (intent === undefined) return raw(400, JSON.stringify({ error: { code: "resource_missing" } }));
      const refund = { id: `re_${(this.counter += 1).toString()}`, status: this.refundStatus, amount: Number(form.get("amount")), currency: intent.currency, payment_intent: intent.id };
      this.refunds.set(refund.id, refund);
      return remember(refund);
    }
    const refundMatch = /^\/refunds\/(re_\d+)$/.exec(path);
    if (refundMatch !== null) {
      const refund = this.refunds.get(refundMatch[1] ?? "");
      return refund === undefined ? raw(404, "{}") : raw(200, JSON.stringify(refund));
    }
    return raw(404, JSON.stringify({ error: { code: "resource_missing" } }));
  }

  private intentJson(intent: StripeIntent, expand: boolean): Record<string, unknown> {
    return {
      id: intent.id,
      object: "payment_intent",
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      client_secret: intent.client_secret,
      amount_received: intent.amount_received,
      latest_charge:
        intent.status === "succeeded"
          ? expand
            ? { id: `ch_${intent.id}`, balance_transaction: { id: `txn_${intent.id}`, fee: intent.fee, currency: intent.currency } }
            : `ch_${intent.id}`
          : null,
    };
  }

  private flutterwave(method: string, path: string, headers: Record<string, string>, body: string): Response {
    if (headers["authorization"] !== `Bearer ${FLW_SECRET}`) return raw(401, JSON.stringify({ status: "error", message: "Invalid authorization key" }));
    if (method === "POST" && path === "/payments") {
      const payload = JSON.parse(body) as { tx_ref: string };
      return raw(200, JSON.stringify({ status: "success", message: "Hosted Link", data: { link: `https://checkout.flutterwave.test/pay/${payload.tx_ref}` } }));
    }
    if (method === "GET" && path.startsWith("/transactions/verify_by_reference")) {
      const txRef = new URLSearchParams(path.split("?")[1]).get("tx_ref") ?? "";
      const payin = this.flwPayins.get(txRef);
      if (payin === undefined) return raw(400, JSON.stringify({ status: "error", message: "No transaction was found for this id", data: null }));
      return raw(200, `{"status":"success","message":"Transaction fetched successfully","data":{"id":${payin.id.toString()},"tx_ref":"${txRef}","amount":${payin.amount},"currency":"${payin.currency}","status":"${payin.status}","app_fee":${payin.app_fee},"payment_type":"bank_transfer"}}`);
    }
    if (method === "POST" && path === "/transfers") {
      if (this.flutterwaveTransfers === "unavailable") return raw(503, "upstream unavailable");
      if (this.flutterwaveTransfers === "reject") return raw(400, JSON.stringify({ status: "error", message: "Invalid account number", data: null }));
      const payload = JSON.parse(body) as { amount: number; currency: string; reference: string; account_bank: string; account_number: string };
      const transfer: FlwTransfer = {
        id: (this.counter += 1),
        amount: String(payload.amount),
        currency: payload.currency,
        status: "NEW",
        fee: "500",
        reference: payload.reference,
        account_bank: payload.account_bank,
        account_number: payload.account_number,
      };
      this.flwTransfers.set(transfer.id, transfer);
      return raw(200, this.flwTransferJson(transfer));
    }
    const transferMatch = /^\/transfers\/(\d+)$/.exec(path);
    if (method === "GET" && transferMatch !== null) {
      const transfer = this.flwTransfers.get(Number(transferMatch[1]));
      return transfer === undefined ? raw(404, JSON.stringify({ status: "error", message: "Transfer not found" })) : raw(200, this.flwTransferJson(transfer));
    }
    const refundMatch = /^\/transactions\/(\d+)\/refund$/.exec(path);
    if (method === "POST" && refundMatch !== null) {
      const payload = JSON.parse(body) as { amount: number };
      return raw(200, `{"status":"success","message":"Transaction refund initiated","data":{"id":${(this.counter += 1).toString()},"tx_id":${refundMatch[1] ?? "0"},"amount_refunded":${String(payload.amount)},"status":"completed"}}`);
    }
    return raw(404, JSON.stringify({ status: "error", message: "not found" }));
  }

  private flwTransferJson(transfer: FlwTransfer): string {
    return `{"status":"success","message":"Transfer fetched","data":{"id":${transfer.id.toString()},"amount":${transfer.amount},"currency":"${transfer.currency}","status":"${transfer.status}","fee":${transfer.fee},"reference":"${transfer.reference}","complete_message":"${transfer.status === "FAILED" ? "Account not found" : ""}"}}`;
  }

  private thunesApi(method: string, path: string, headers: Record<string, string>, body: string): Response {
    if (headers["authorization"] !== `Basic ${Buffer.from(`${THUNES_KEY}:${THUNES_SECRET}`).toString("base64")}`) return raw(401, JSON.stringify({ errors: [{ code: "1000401", message: "Unauthorized" }] }));
    if (method === "POST" && path === "/v2/money-transfer/quotations") {
      if (this.thunesQuotations === "reject") return raw(400, JSON.stringify({ errors: [{ code: "1003001", message: "Payer not available" }] }));
      const payload = JSON.parse(body) as { external_id: string; destination: { amount: string; currency: string } };
      this.thunes.set(`q:${payload.external_id}`, { id: (this.counter += 1), external_id: payload.external_id, status_class: "0", destination: payload.destination, confirmed: false });
      return raw(201, JSON.stringify({ id: this.counter, external_id: payload.external_id }));
    }
    const create = /^\/v2\/money-transfer\/quotations\/ext-([^/]+)\/transactions$/.exec(path);
    if (method === "POST" && create !== null) {
      const quotation = this.thunes.get(`q:${decodeURIComponent(create[1] ?? "")}`);
      if (quotation === undefined) return raw(404, JSON.stringify({ errors: [{ code: "1003404", message: "Quotation not found" }] }));
      const payload = JSON.parse(body) as { external_id: string };
      const transaction: ThunesTransaction = { id: (this.counter += 1), external_id: payload.external_id, status_class: "1", destination: quotation.destination, confirmed: false };
      this.thunes.set(payload.external_id, transaction);
      return raw(201, JSON.stringify({ ...transaction, status: "10000", status_message: "CREATED" }));
    }
    const confirm = /^\/v2\/money-transfer\/transactions\/ext-([^/]+)\/confirm$/.exec(path);
    if (method === "POST" && confirm !== null) {
      const transaction = this.thunes.get(decodeURIComponent(confirm[1] ?? ""));
      if (transaction === undefined) return raw(404, JSON.stringify({ errors: [{ code: "1003404", message: "Not found" }] }));
      transaction.confirmed = true;
      transaction.status_class = "2";
      return raw(200, JSON.stringify({ ...transaction, status: "20000", status_message: "CONFIRMED" }));
    }
    const get = /^\/v2\/money-transfer\/transactions\/ext-([^/]+)$/.exec(path);
    if (method === "GET" && get !== null) {
      const transaction = this.thunes.get(decodeURIComponent(get[1] ?? ""));
      if (transaction === undefined) return raw(404, JSON.stringify({ errors: [{ code: "1003404", message: "Not found" }] }));
      return raw(200, JSON.stringify({ ...transaction, status_class_message: transaction.status_class === "7" ? "COMPLETED" : "DECLINED", fee: { amount: 300, currency: transaction.destination.currency } }));
    }
    return raw(404, JSON.stringify({ errors: [{ code: "404", message: "not found" }] }));
  }
}

function raw(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

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

const keys = await createTestKeys();
const config = buildTestConfig(keys, {
  STRIPE_SECRET_KEY: STRIPE_SECRET,
  STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE,
  STRIPE_WEBHOOK_SECRET,
  FLUTTERWAVE_SECRET_KEY: FLW_SECRET,
  FLUTTERWAVE_WEBHOOK_HASH: FLW_HASH,
  FLUTTERWAVE_REDIRECT_URL: "https://app.transfertplus.test/payments/return",
  THUNES_BASE_URL: THUNES_BASE,
  THUNES_API_KEY: THUNES_KEY,
  THUNES_API_SECRET: THUNES_SECRET,
  THUNES_CALLBACK_URL: "https://api.transfertplus.test/v1/webhooks/thunes",
  PAYOUT_MAX_ROUTES: "3",
  CIRCUIT_FAILURE_THRESHOLD: "3",
  CIRCUIT_OPEN_SECONDS: "60",
  PAYMENTS_FUNDING_TTL_MINUTES: "60",
});
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const fake = new FakePaymentProviders();
const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
const inbox = new WebhookInbox(apiPool, silentLogger);
const transfersModule = createTransfersModule({
  config,
  pool: apiPool,
  logger: silentLogger,
  verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
  sessions: new PostgresSessionValidator(apiPool),
  deviceBinding: new DeviceBindingService(apiPool),
  mfa: new MfaService(apiPool, encryptor),
  encryptor,
  indexer: new BlindIndexer(config.crypto.blindIndexKey),
  inbox,
  limiters: {
    transfersBySubject: createMemoryRateLimiter({ keyPrefix: "transfers", points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }),
    recipientsBySubject: createMemoryRateLimiter({ keyPrefix: "recipients", points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }),
  },
  providers: configuredPaymentProviders(config, fake.fetch),
  dispatch: "inline",
  webhookProcessing: "inline",
});
const orchestrator = transfersModule.stack.orchestrator;
const app = buildTestApp(config, {
  mountRoutes: (application) => {
    application.use(transfersModule.router);
  },
});

const corridorIds: string[] = [];
let disabledCorridors: string[] = [];

interface Customer {
  readonly userId: string;
  readonly token: string;
  readonly secret: Buffer;
  step: number;
}

/** Client vérifié (niveau 1), identité déclarée chiffrée, TOTP activé, portefeuille EUR approvisionné. */
async function verifiedCustomer(options: { readonly walletEur?: bigint; readonly tier?: "tier_0" | "tier_1"; readonly email?: boolean } = {}): Promise<Customer> {
  const seeded = await seedCustomer(owner);
  const userId = seeded.userId;
  const context = (column: string): string => fieldContext("identity", "users", column, userId);
  const secret = generateTotpSecret();
  await owner.query(
    `UPDATE identity.users
        SET phone_enc = $2, first_name_enc = $3, last_name_enc = $4, date_of_birth_enc = $5,
            mfa_totp_secret_enc = $6, mfa_totp_enabled_at = now(),
            email_enc = $7, email_bidx = $8
      WHERE id = $1`,
    [
      userId,
      await encryptor.encrypt("+33612345678", context("phone")),
      await encryptor.encrypt("Aminata", context("first_name")),
      await encryptor.encrypt("Diop", context("last_name")),
      await encryptor.encrypt("1988-02-14", context("date_of_birth")),
      await encryptor.encrypt(secret.toString("base64"), context("mfa_totp_secret")),
      options.email === false ? null : await encryptor.encrypt(`aminata.${userId}@example.test`, context("email")),
      options.email === false ? null : randomBytes(32),
    ],
  );
  if ((options.tier ?? "tier_1") === "tier_1") await grantKycTier(owner, userId);
  const wallet = options.walletEur ?? 50000n;
  if (wallet > 0n) {
    await owner.query(
      `SELECT ledger.post_journal($1, 'wallet_funding',
               jsonb_build_array(
                 jsonb_build_object('account_id', ledger.open_system_account('provider_settlement', 'EUR', 'stripe'), 'direction', 'debit', 'amount', $2::bigint, 'currency', 'EUR'),
                 jsonb_build_object('account_id', ledger.open_customer_account($3, 'customer_wallet', 'EUR'), 'direction', 'credit', 'amount', $2::bigint, 'currency', 'EUR')),
               'Rechargement de test', 'system:tests')`,
      [`test:wallet:${userId}`, wallet.toString(), userId],
    );
  }
  const token = await signAccessToken({ key: keys.customer, audience: "web", subject: userId, sessionId: seeded.webSessionId });
  return { userId, token, secret, step: timeStep(Date.now() / 1000) - 1 };
}

function totp(customer: Customer): string {
  customer.step += 1;
  return hotp(customer.secret, customer.step);
}

async function addRecipient(customer: Customer, msisdn = "+221771234567"): Promise<string> {
  const response = await request(app)
    .post("/v1/recipients")
    .set("Authorization", `Bearer ${customer.token}`)
    .send({ country: "SN", currency: "XOF", firstName: "Moussa", lastName: "Ndiaye", relationship: "family", account: { kind: "mobile_money", msisdn, operator: "orange_money" } });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

/** Devis garanti cohérent (vérifié par fx.quotes_validate) : 100,00 EUR → 64 611 XOF, frais 1,99 EUR. */
async function quote(customer: Customer, fundingMethod: string, sourceAmount = 10000n): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                            funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                            margin_bps, usd_equivalent, expires_at)
     VALUES ($1, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', $2::transfers.funding_method, $3::bigint, 199, $3::bigint + 199,
             fx.convert_minor($3::bigint, 646.117645, 'EUR', 'XOF'), 655.957, 646.117645, 150, ($3::bigint * 108.69 / 100)::bigint,
             now() + interval '10 minutes')
     RETURNING id`,
    [customer.userId, fundingMethod, sourceAmount.toString()],
  );
  return result.rows[0]!.id;
}

async function createTransfer(customer: Customer, body: Record<string, unknown>, key = `idem-${randomUUID()}`) {
  return request(app).post("/v1/transfers").set("Authorization", `Bearer ${customer.token}`).set("Idempotency-Key", key).send(body);
}

async function transferStatus(id: string): Promise<string> {
  return (await owner.query<{ status: string }>("SELECT status::text FROM transfers.transfers WHERE id = $1", [id])).rows[0]!.status;
}

async function balance(where: { readonly type: string; readonly currency: string; readonly provider?: string; readonly userId?: string }): Promise<bigint> {
  const result = await owner.query<{ balance: string }>(
    `SELECT COALESCE(sum(b.balance), 0)::text AS balance
       FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
      WHERE a.account_type = $1::ledger.account_type AND a.currency = $2
        AND a.provider IS NOT DISTINCT FROM $3::payments.provider AND a.owner_user_id IS NOT DISTINCT FROM $4::uuid`,
    [where.type, where.currency, where.provider ?? null, where.userId ?? null],
  );
  return BigInt(result.rows[0]!.balance);
}

async function journals(transferId: string): Promise<string[]> {
  const result = await owner.query<{ key: string }>(
    "SELECT idempotency_key AS key FROM ledger.journals WHERE reference_id = $1 OR idempotency_key LIKE $2 ORDER BY seq",
    [transferId, `%${transferId}%`],
  );
  return result.rows.map((row) => row.key.replace(transferId, "T").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "A"));
}

async function payoutAttempts(transferId: string): Promise<{ provider: string; status: string; provider_reference: string | null; failure_code: string | null }[]> {
  const result = await owner.query<{ provider: string; status: string; provider_reference: string | null; failure_code: string | null }>(
    "SELECT provider::text, status::text, provider_reference, failure_code FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout' ORDER BY created_at",
    [transferId],
  );
  return result.rows;
}

async function postFlutterwave(payload: Record<string, unknown>, hash = FLW_HASH) {
  return request(app).post("/v1/webhooks/flutterwave").set("Content-Type", "application/json").set("verif-hash", hash).send(JSON.stringify(payload));
}

async function postStripe(event: Record<string, unknown>, secret = STRIPE_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(`${timestamp.toString()}.${body}`).digest("hex");
  return request(app).post("/v1/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", `t=${timestamp.toString()},v1=${signature}`).send(body);
}

async function postThunes(payload: Record<string, unknown>) {
  return request(app).post("/v1/webhooks/thunes").set("Content-Type", "application/json").send(JSON.stringify(payload));
}

async function age(table: "payments.attempts" | "transfers.transfers", id: string, assignments: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE ${table} SET ${assignments} WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function fundFloat(provider: "flutterwave" | "thunes", amount: bigint): Promise<void> {
  await owner.query(
    `SELECT ledger.post_journal($1, 'capital_injection',
             jsonb_build_array(
               jsonb_build_object('account_id', ledger.open_system_account('provider_settlement', 'XOF', $2::payments.provider), 'direction', 'debit', 'amount', $3::bigint, 'currency', 'XOF'),
               jsonb_build_object('account_id', ledger.open_system_account('equity', 'XOF', NULL), 'direction', 'credit', 'amount', $3::bigint, 'currency', 'XOF')),
             'Préfinancement de test', 'system:tests')`,
    [`test:float:${provider}:${randomUUID()}`, provider, amount.toString()],
  );
}

beforeAll(async () => {
  await owner.query("UPDATE ref.countries SET can_send = true WHERE alpha2 = 'FR'");
  await owner.query("UPDATE ref.countries SET can_receive = true WHERE alpha2 = 'SN'");
  await owner.query("UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF')");
  await owner.query("UPDATE payments.providers SET is_enabled = true");
  const others = await owner.query<{ id: string }>("UPDATE payments.payout_corridors SET is_enabled = false WHERE destination_country = 'SN' AND is_enabled RETURNING id");
  disabledCorridors = others.rows.map((row) => row.id);
  const corridors = await owner.query<{ id: string }>(
    `INSERT INTO payments.payout_corridors (source_country, destination_country, destination_currency, payout_method, provider, priority,
                                            min_amount, max_amount, cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled, provider_route_code)
     VALUES ('FR', 'SN', 'XOF', 'mobile_money', 'flutterwave', 10, 500, 5000000, 0, 50, 5, true, 'FMM'),
            ('FR', 'SN', 'XOF', 'mobile_money', 'thunes', 20, 500, 5000000, 300, 0, 30, true, '4021')
     RETURNING id`,
  );
  corridorIds.push(...corridors.rows.map((row) => row.id));
  await owner.query(
    `INSERT INTO payments.payin_methods (country, currency, funding_method, provider, priority, min_amount, max_amount, cost_fixed, cost_bps, is_enabled)
     VALUES ('FR', 'EUR', 'card', 'stripe', 10, 100, 10000000, 25, 140, true),
            ('FR', 'EUR', 'bank_transfer', 'flutterwave', 10, 100, 10000000, 0, 100, true)
     ON CONFLICT (country, currency, funding_method, provider) DO UPDATE SET is_enabled = true`,
  );
  await fundFloat("flutterwave", 10_000_000n);
  await fundFloat("thunes", 10_000_000n);
});

beforeEach(async () => {
  fake.reset();
  await owner.query("UPDATE payments.provider_health SET circuit_state = 'closed', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL");
});

afterAll(async () => {
  await owner.query("UPDATE payments.payout_corridors SET is_enabled = false WHERE id = ANY($1::uuid[])", [corridorIds]);
  await owner.query("UPDATE payments.payout_corridors SET is_enabled = true WHERE id = ANY($1::uuid[])", [disabledCorridors]);
  await owner.query("UPDATE payments.provider_health SET circuit_state = 'closed', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL");
  await apiPool.end();
  await owner.end();
});

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
    expect(await balance({ type: "payout_clearing", currency: "XOF", provider: "flutterwave" })).toBe(0n);
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
