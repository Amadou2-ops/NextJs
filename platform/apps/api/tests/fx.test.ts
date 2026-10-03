import { randomBytes } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { convertMinor, minimalSourceForTarget, Money, normalizeDecimalLiteral, parseCurrencyCode, relativeDifferenceBps } from "../src/lib/money.js";
import { createMemoryRateLimiter } from "../src/middlewares/rateLimit.js";
import { createFxModule } from "../src/modules/fx/index.js";
import { FixerClient } from "../src/modules/fx/providers/fixer.client.js";
import { OpenExchangeRatesClient } from "../src/modules/fx/providers/openExchangeRates.client.js";
import { RateProviderError } from "../src/modules/fx/providers/types.js";
import type { RateProvider, RateSet } from "../src/modules/fx/providers/types.js";
import { QuoteService } from "../src/modules/fx/quote.service.js";
import { RateIngestionService } from "../src/modules/fx/rateIngestion.service.js";
import { buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, seedCustomer, signAccessToken, silentLogger } from "./support/fixtures.js";
import type { SeededCustomer } from "./support/fixtures.js";

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const generous = { points: 10_000, durationSeconds: 60, blockDurationSeconds: 0 };
const fxModule = createFxModule({
  config,
  pool: apiPool,
  verifier: new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks),
  sessions: new PostgresSessionValidator(apiPool),
  limiters: {
    estimateByIp: createMemoryRateLimiter({ keyPrefix: "fx-estimate", ...generous }),
    quotesBySubject: createMemoryRateLimiter({ keyPrefix: "fx-quotes", ...generous }),
  },
});
const app = buildTestApp(config, {
  mountRoutes: (application) => {
    application.use(fxModule.router);
  },
});

let customer: SeededCustomer;
let token: string;

/** Corridor France → Sénégal (XOF, mobile money) entièrement configuré. */
async function configureCorridors(): Promise<void> {
  await owner.query("UPDATE ref.countries SET can_send = true WHERE alpha2 IN ('FR', 'US')");
  await owner.query("UPDATE ref.countries SET can_receive = true WHERE alpha2 IN ('SN', 'GH', 'KE')");
  await owner.query("UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF', 'GHS', 'KES')");
  await owner.query("UPDATE payments.providers SET is_enabled = true WHERE code = 'flutterwave'");
  await owner.query(
    `INSERT INTO payments.payout_corridors (destination_country, destination_currency, payout_method, provider, min_amount, max_amount,
                                            cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled)
     VALUES ('SN', 'XOF', 'mobile_money', 'flutterwave', 500, 2000000, 0, 50, 5, true),
            ('GH', 'GHS', 'mobile_money', 'flutterwave', 100, 500000, 0, 50, 10, true),
            ('KE', 'KES', 'mobile_money', 'flutterwave', 100, 5000000, 0, 50, 10, true)
     ON CONFLICT DO NOTHING`,
  );
  await owner.query("INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps, priority) VALUES ('EUR', 'XOF', 150, 10)");
  await owner.query("INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps, priority) VALUES (NULL, NULL, 300, 0)");
  await owner.query("INSERT INTO transfers.fee_schedules (source_currency, fixed_fee, percentage_bps, min_fee, priority) VALUES ('EUR', 199, 0, 0, 0)");
  await owner.query("INSERT INTO transfers.fee_schedules (source_currency, funding_method, fixed_fee, percentage_bps, min_fee, max_fee, priority) VALUES ('EUR', 'wallet_balance', 0, 50, 49, 999, 0)");
  // Taux frais (Open Exchange Rates) : 1 USD = 0,92 EUR = 603,48 XOF.
  await owner.query(
    `INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
     VALUES ('open_exchange_rates', 'USD', 'EUR', 0.92, now() - interval '10 minutes'),
            ('open_exchange_rates', 'USD', 'XOF', 603.48, now() - interval '10 minutes'),
            ('open_exchange_rates', 'USD', 'GHS', 15.2, now() - interval '10 minutes'),
            ('fixer', 'USD', 'GHS', 16.1, now() - interval '5 minutes'),
            ('open_exchange_rates', 'USD', 'KES', 129.5, now() - interval '5 hours')`,
  );
}

beforeAll(async () => {
  await configureCorridors();
  customer = await seedCustomer(owner);
  token = await signAccessToken({ key: keys.customer, audience: "web", subject: customer.userId, sessionId: customer.webSessionId });
});

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("décimaux exacts", () => {
  it.each([
    ["655.957", "655.957"],
    ["1.23E-7", "0.000000123"],
    ["1e3", "1000"],
    ["0.1234567890123456789", "0.123456789012346"],
    ["603.480000000000000000", "603.48"],
    ["5e-16", "0.000000000000001"],
  ])("normalise %s en %s", (input, expected) => {
    expect(normalizeDecimalLiteral(input)).toBe(expected);
  });

  it.each(["0", "0.0000000000000001", "2.5e-16", "-1", "abc", "1e40"])("refuse %s", (input) => {
    expect(() => normalizeDecimalLiteral(input)).toThrow();
  });

  it("mesure l'écart relatif en points de base", () => {
    expect(relativeDifferenceBps("101", "100")).toBe(100);
    expect(relativeDifferenceBps("99", "100")).toBe(100);
    expect(relativeDifferenceBps("100.0001", "100")).toBe(1);
    expect(relativeDifferenceBps("603.48", "603.48")).toBe(0);
  });

  it("trouve le montant source minimal pour un montant reçu (propriété)", () => {
    for (let index = 0; index < 300; index += 1) {
      const target = BigInt(1 + Math.floor(Math.random() * 10_000_000));
      const rate = normalizeDecimalLiteral((0.001 + Math.random() * 2000).toFixed(9));
      const [su, du] = [[2, 0], [0, 2], [2, 2], [3, 2], [0, 0]][index % 5] as [number, number];
      const source = minimalSourceForTarget(target, rate, su, du);
      expect(convertMinor(source, rate, su, du) >= target).toBe(true);
      if (source > 1n) expect(convertMinor(source - 1n, rate, su, du) < target).toBe(true);
    }
  });
});

describe("fournisseurs de taux", () => {
  function fakeFetch(status: number, body: string, seen: { url?: string; headers?: Record<string, string> }) {
    return ((url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      return Promise.resolve(new Response(body, { status }));
    }) as unknown as typeof fetch;
  }

  it("Open Exchange Rates : lit les taux au décimal près, clé hors de l'URL", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const appId = "a".repeat(32);
    const client = new OpenExchangeRatesClient(appId, fakeFetch(200, '{"timestamp":1791000000,"base":"USD","rates":{"EUR":0.920123456789012345,"XOF":603.48,"BTC":1.6e-5,"ZZZ":0}}', seen));
    const set = await client.fetchLatest();
    expect(set.rates.get("EUR")).toBe("0.920123456789012");
    expect(set.rates.get("XOF")).toBe("603.48");
    expect(set.rates.get("BTC")).toBe("0.000016");
    expect(set.rates.has("ZZZ")).toBe(false);
    expect(set.timestamp.toISOString()).toBe(new Date(1_791_000_000_000).toISOString());
    expect(seen.url).not.toContain(appId);
    expect(seen.headers?.["Authorization"]).toBe(`Token ${appId}`);
  });

  it("Fixer : authentifie par en-tête et refuse une base autre que USD", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const key = "B".repeat(32);
    const ok = new FixerClient(key, fakeFetch(200, '{"success":true,"timestamp":1791000000,"base":"USD","rates":{"XOF":603.5}}', seen));
    expect((await ok.fetchLatest()).rates.get("XOF")).toBe("603.5");
    expect(seen.url).not.toContain(key);
    expect(seen.headers?.["apikey"]).toBe(key);
    const eurBase = new FixerClient(key, fakeFetch(200, '{"success":true,"timestamp":1791000000,"base":"EUR","rates":{}}', {}));
    await expect(eurBase.fetchLatest()).rejects.toThrow(/base inattendue/);
    const failure = new FixerClient(key, fakeFetch(200, '{"success":false,"error":{"code":101,"type":"invalid_access_key"}}', {}));
    await expect(failure.fetchLatest()).rejects.toThrow(RateProviderError);
  });

  it("signale une erreur HTTP ou un fournisseur injoignable", async () => {
    await expect(new OpenExchangeRatesClient("a".repeat(32), fakeFetch(401, '{"error":true,"message":"invalid_app_id"}', {})).fetchLatest()).rejects.toThrow(/invalid_app_id/);
    const unreachable = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await expect(new OpenExchangeRatesClient("a".repeat(32), unreachable).fetchLatest()).rejects.toThrow(/injoignable/);
  });
});

describe("collecte des taux", () => {
  class StaticProvider implements RateProvider {
    constructor(
      readonly name: "open_exchange_rates" | "fixer",
      private readonly set: () => RateSet,
    ) {}
    fetchLatest(): Promise<RateSet> {
      return Promise.resolve(this.set());
    }
  }

  const ingestion = new RateIngestionService(apiPool, silentLogger, 1000);

  it("stocke les taux des devises connues et trace la collecte", async () => {
    const timestamp = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1000));
    const result = await ingestion.ingest(
      new StaticProvider("fixer", () => ({ provider: "fixer", base: "USD", timestamp, rates: new Map([["GBP", "0.78"], ["JPY", "151.2"], ["ZZZ", "1"]]) })),
    );
    expect(result).toMatchObject({ status: "succeeded", received: 3, stored: 2, rejected: [] });
    const fetches = await owner.query<{ status: string; rates_stored: number }>("SELECT status, rates_stored FROM fx.rate_fetches WHERE provider = 'fixer' ORDER BY id DESC LIMIT 1");
    expect(fetches.rows[0]).toEqual({ status: "succeeded", rates_stored: 2 });
  });

  it("rejette une variation anormale et émet une alerte", async () => {
    const result = await ingestion.ingest(
      new StaticProvider("fixer", () => ({ provider: "fixer", base: "USD", timestamp: new Date(), rates: new Map([["GBP", "0.95"], ["JPY", "151.3"]]) })),
    );
    expect(result.status).toBe("partially_rejected");
    expect(result.rejected.map((item) => item.currency)).toEqual(["GBP"]);
    expect(result.stored).toBe(1);
    const alert = await owner.query("SELECT 1 FROM integrations.outbox WHERE event_type = 'fx.rate_rejected' AND payload->>'provider' = 'fixer'");
    expect(alert.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("trace un échec et refuse des taux trop anciens", async () => {
    const stale = new StaticProvider("fixer", () => ({ provider: "fixer", base: "USD", timestamp: new Date(Date.now() - 48 * 3600_000), rates: new Map([["GBP", "0.78"]]) }));
    await expect(ingestion.ingest(stale)).rejects.toThrow(/trop anciens/);
    const failed = await owner.query<{ status: string; error_message: string }>("SELECT status, error_message FROM fx.rate_fetches ORDER BY id DESC LIMIT 1");
    expect(failed.rows[0]?.status).toBe("failed");
  });
});

describe("frais", () => {
  it("calcule comme transfers.compute_fee (parité avec la base)", async () => {
    const schedule = await owner.query<{ id: string }>(
      "INSERT INTO transfers.fee_schedules (source_currency, fixed_fee, percentage_bps, min_fee, max_fee, priority, valid_from) VALUES ('USD', 25, 175, 99, 2500, -100, now() + interval '1 day') RETURNING id",
    );
    const id = schedule.rows[0]!.id;
    for (const amount of [1n, 99n, 1_000n, 12_345n, 99_999n, 1_000_000n, 9_999_999n]) {
      const sql = await owner.query<{ fee: string }>("SELECT transfers.compute_fee($1, $2)::text AS fee", [id, amount.toString()]);
      const fee = QuoteService.computeFee(Money.ofMinor(amount, parseCurrencyCode("USD")), { fixedFee: 25n, bps: 175, minFee: 99n, maxFee: 2500n });
      expect(fee.amountMinor.toString()).toBe(sql.rows[0]?.fee);
    }
  });
});

describe("devis", () => {
  const base = {
    sourceCountry: "FR",
    destinationCountry: "SN",
    sourceCurrency: "EUR",
    destinationCurrency: "XOF",
    payoutMethod: "mobile_money",
    fundingMethod: "card",
  } as const;

  it("simule un envoi de 100,00 EUR au centime près (valeurs calculées indépendamment)", async () => {
    const response = await request(app).get("/v1/fx/estimate").query({ ...base, amount: "10000" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      quoteId: null,
      sourceCountry: "FR",
      destinationCountry: "SN",
      payoutMethod: "mobile_money",
      fundingMethod: "card",
      sendAmount: { amount: "10000", currency: "EUR" },
      fee: { amount: "199", currency: "EUR" },
      totalToPay: { amount: "10199", currency: "EUR" },
      receiveAmount: { amount: "64611", currency: "XOF" },
      exchangeRate: "646.117173913043478",
      estimatedDeliveryMinutes: 5,
      rateTimestamp: expect.any(String) as string,
      expiresAt: null,
    });
  });

  it("calcule le montant à envoyer pour un montant reçu garanti", async () => {
    const response = await request(app).get("/v1/fx/estimate").query({ ...base, amount: "65000", amountType: "receive" });
    expect(response.body.sendAmount).toEqual({ amount: "10061", currency: "EUR" });
    expect(response.body.receiveAmount).toEqual({ amount: "65005", currency: "XOF" });
  });

  it("applique le barème de frais propre au mode de financement", async () => {
    const response = await request(app).get("/v1/fx/estimate").query({ ...base, fundingMethod: "wallet_balance", amount: "100000" });
    expect(response.body.fee).toEqual({ amount: "500", currency: "EUR" });
    const capped = await request(app).get("/v1/fx/estimate").query({ ...base, fundingMethod: "wallet_balance", amount: "250000" });
    expect(capped.body.fee).toEqual({ amount: "999", currency: "EUR" });
  });

  it("enregistre un devis accepté par la base et consommable par un transfert", async () => {
    const response = await request(app).post("/v1/quotes").set("Authorization", `Bearer ${token}`).send({ ...base, sourceCountry: undefined, amount: "10000" });
    expect(response.status).toBe(201);
    expect(response.body.quoteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(response.body.expiresAt as string).getTime() - Date.now()).toBeGreaterThan(500_000);

    const stored = await owner.query<{ usd_equivalent: string; margin_bps: number; funding_method: string; source_leg_snapshot_id: string | null }>(
      "SELECT usd_equivalent::text, margin_bps, funding_method, source_leg_snapshot_id::text FROM fx.quotes WHERE id = $1",
      [response.body.quoteId],
    );
    expect(stored.rows[0]).toMatchObject({ usd_equivalent: "10869", margin_bps: 150, funding_method: "card" });
    expect(stored.rows[0]?.source_leg_snapshot_id).not.toBeNull();

    const recipient = await owner.query<{ id: string }>(
      `INSERT INTO transfers.recipients (user_id, country, currency, payout_method, full_name_enc, account_details_enc, account_details_bidx,
                                        display_hint, mobile_operator, pii_key_id)
       VALUES ($1, 'SN', 'XOF', 'mobile_money', '\\x01', '\\x02', $2, '•••• 4567', 'orange_money', 'pii-2026-01') RETURNING id`,
      [customer.userId, randomBytes(32)],
    );
    const transfer = await owner.query<{ reference: string }>(
      `INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency, destination_currency,
                                        source_amount, fee_amount, total_debit, destination_amount, customer_rate, usd_equivalent, funding_method,
                                        payout_method, purpose_code, idempotency_key, authorization_method, authorized_at)
       SELECT q.user_id, $2, q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency, q.source_amount,
              q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate, q.usd_equivalent, q.funding_method, q.payout_method,
              'family_support', $3, 'totp', now()
         FROM fx.quotes q WHERE q.id = $1
       RETURNING reference`,
      [response.body.quoteId, recipient.rows[0]!.id, randomBytes(12).toString("hex")],
    );
    expect(transfer.rows[0]?.reference).toMatch(/^TP/);

    const consumed = await request(app).get(`/v1/quotes/${response.body.quoteId as string}`).set("Authorization", `Bearer ${token}`);
    expect(consumed.body).toMatchObject({ consumed: true, receiveAmount: { amount: "64611", currency: "XOF" }, fundingMethod: "card" });
    expect(consumed.body.estimatedDeliveryMinutes).toBe(5);
    expect(consumed.body.rateTimestamp).toBe(response.body.rateTimestamp);
  });

  it("refuse un pays de destination fermé, un corridor absent ou un montant hors limites", async () => {
    expect((await request(app).get("/v1/fx/estimate").query({ ...base, destinationCountry: "CI", amount: "10000" })).status).toBe(422);
    expect((await request(app).get("/v1/fx/estimate").query({ ...base, payoutMethod: "cash_pickup", amount: "10000" })).status).toBe(422);
    const tooSmall = await request(app).get("/v1/fx/estimate").query({ ...base, amount: "1" });
    expect(tooSmall.status).toBe(422);
    const tooLarge = await request(app).get("/v1/fx/estimate").query({ ...base, amount: "999999999" });
    expect(tooLarge.status).toBe(422);
    expect(tooLarge.body.detail).toMatch(/compris entre/);
  });

  it("refuse les taux trop anciens", async () => {
    const response = await request(app).get("/v1/fx/estimate").query({ ...base, destinationCountry: "KE", destinationCurrency: "KES", amount: "10000" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("refuse tout devis si deux fournisseurs divergent", async () => {
    const response = await request(app).get("/v1/fx/estimate").query({ ...base, destinationCountry: "GH", destinationCurrency: "GHS", amount: "10000" });
    expect(response.status).toBe(503);
    expect(Number(response.headers["retry-after"])).toBe(300);
  });

  it("valide les paramètres et protège les devis des autres clients", async () => {
    expect((await request(app).get("/v1/fx/estimate").query({ ...base, amount: "10.5" })).status).toBe(400);
    expect((await request(app).get("/v1/fx/estimate").query({ ...base, amount: "100", hack: "1" })).status).toBe(400);
    expect((await request(app).post("/v1/quotes").send({ ...base, amount: "10000" })).status).toBe(401);
    const mine = await request(app).post("/v1/quotes").set("Authorization", `Bearer ${token}`).send({ ...base, sourceCountry: undefined, amount: "5000" });
    const other = await seedCustomer(owner);
    const otherToken = await signAccessToken({ key: keys.customer, audience: "web", subject: other.userId, sessionId: other.webSessionId });
    expect((await request(app).get(`/v1/quotes/${mine.body.quoteId as string}`).set("Authorization", `Bearer ${otherToken}`)).status).toBe(404);
  });
});
