import { createHmac, randomBytes, randomUUID } from "node:crypto";

import request from "supertest";
import { expect } from "vitest";

import { AccessTokenVerifier } from "../../src/auth/accessToken.js";
import { PostgresPermissionChecker } from "../../src/auth/permissions.js";
import { PostgresSessionValidator } from "../../src/auth/sessions.js";
import { BlindIndexer } from "../../src/lib/crypto/blindIndex.js";
import { FieldEncryptor, KeyringKeyProvider, fieldContext } from "../../src/lib/crypto/fieldEncryption.js";
import { createMemoryRateLimiter } from "../../src/middlewares/rateLimit.js";
import { ListIngestionService } from "../../src/modules/aml/listIngestion.service.js";
import type { ListEntry, ListSource } from "../../src/modules/aml/lists/sources.js";
import { DeviceBindingService } from "../../src/modules/auth/deviceBinding.service.js";
import { MfaService } from "../../src/modules/auth/mfa.service.js";
import { createBackofficeModule } from "../../src/modules/backoffice/index.js";
import { createQuoteService } from "../../src/modules/fx/index.js";
import { createLedgerModule } from "../../src/modules/ledger/index.js";
import { generateTotpSecret, hotp, timeStep } from "../../src/modules/auth/totp.js";
import { configuredPaymentProviders, createTransfersModule } from "../../src/modules/transfers/index.js";
import { WebhookInbox } from "../../src/modules/webhooks/webhookInbox.js";
import {
  FakePaymentProviders,
  FLW_HASH,
  FLW_SECRET,
  STRIPE_PUBLISHABLE,
  STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET,
  THUNES_BASE,
  THUNES_KEY,
  THUNES_SECRET,
} from "./fakePayments.js";
import { buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, grantKycTier, seedCustomer, signAccessToken, silentLogger } from "./fixtures.js";

/**
 * Banc d'essai des transferts : application montée avec les vrais clients
 * prestataires branchés sur des faux en mémoire, données de référence
 * (corridors, moyens d'encaissement, trésorerie), listes de criblage de
 * test, clients vérifiés (KYC niveau 1, identité déclarée chiffrée, TOTP,
 * portefeuille approvisionné).
 */

/** Liste de sanctions de test : homonymes connus utilisés par les tests AML. */
export const TEST_SANCTIONS: readonly ListEntry[] = [
  { externalId: "9001", entryType: "individual", primaryName: "OUSMANE, Amadou Karim", aliases: ["Amadou K. OUSMANE"], birthDates: ["12 Mar 1971"], countries: ["Mali"], programs: ["SDGT"] },
  { externalId: "9002", entryType: "entity", primaryName: "SAHEL TRADING COMPANY", aliases: [], birthDates: [], countries: [], programs: ["SDGT"] },
];
export const TEST_PEPS: readonly ListEntry[] = [
  { externalId: "Q-PEP-1", entryType: "individual", primaryName: "Fatoumata Bintou CAMARA", aliases: [], birthDates: ["1965-05-20"], countries: ["GN"], programs: ["peps"] },
];

export function staticListSource(name: string, kind: "sanctions" | "pep", entries: readonly ListEntry[]): ListSource {
  const content = Buffer.from(JSON.stringify(entries));
  return {
    name,
    kind,
    fetchList: () => Promise.resolve({ version: `test-${entries.length.toString()}`, contentSha256: createHashSha256(content), entries }),
  };
}

function createHashSha256(content: Buffer): Buffer {
  return createHmac("sha256", "listes-de-test").update(content).digest();
}

export interface Customer {
  readonly userId: string;
  readonly token: string;
  readonly secret: Buffer;
  step: number;
}

export async function createPaymentHarness(extraConfig: Record<string, string> = {}) {
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
    ...extraConfig,
  });
  const owner = createOwnerPool();
  const apiPool = createApiPool(config);
  const fake = new FakePaymentProviders();
  const encryptor = new FieldEncryptor(new KeyringKeyProvider(config.crypto.piiKeyring.activeKeyId, config.crypto.piiKeyring.keys));
  const inbox = new WebhookInbox(apiPool, silentLogger);
  const indexer = new BlindIndexer(config.crypto.blindIndexKey);
  const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
  const sessions = new PostgresSessionValidator(apiPool);
  const transfersModule = createTransfersModule({
    config,
    pool: apiPool,
    logger: silentLogger,
    verifier,
    sessions,
    deviceBinding: new DeviceBindingService(apiPool),
    mfa: new MfaService(apiPool, encryptor),
    encryptor,
    indexer,
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
  const backoffice = createBackofficeModule({
    config,
    pool: apiPool,
    logger: silentLogger,
    verifier,
    sessions,
    encryptor,
    indexer,
    ledger: transfersModule.stack.ledger,
    orchestrator,
    quotes: createQuoteService(config, apiPool),
    limiters: {
      loginByIp: createMemoryRateLimiter({ keyPrefix: "admin-login-ip", points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }),
      loginByEmail: createMemoryRateLimiter({ keyPrefix: "admin-login-email", points: 1000, durationSeconds: 60, blockDurationSeconds: 0 }),
    },
    breachChecker: null,
  });
  const ledgerModule = createLedgerModule({ pool: apiPool, verifier, sessions, permissions: new PostgresPermissionChecker(apiPool), deviceBinding: new DeviceBindingService(apiPool) });
  const app = buildTestApp(config, {
    mountRoutes: (application) => {
      application.use(backoffice.router);
      application.use(transfersModule.router);
      application.use(ledgerModule.router);
    },
  });

  const corridorIds: string[] = [];
  let disabledCorridors: string[] = [];


  /** Client vérifié (niveau 1), identité déclarée chiffrée, TOTP activé, portefeuille EUR approvisionné. */
  async function verifiedCustomer(options: { readonly walletEur?: bigint; readonly tier?: "tier_0" | "tier_1" | "tier_2"; readonly email?: boolean; readonly identity?: { readonly firstName: string; readonly lastName: string; readonly dateOfBirth: string } } = {}): Promise<Customer> {
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
        await encryptor.encrypt(options.identity?.firstName ?? "Aminata", context("first_name")),
        await encryptor.encrypt(options.identity?.lastName ?? "Diop", context("last_name")),
        await encryptor.encrypt(options.identity?.dateOfBirth ?? "1988-02-14", context("date_of_birth")),
        await encryptor.encrypt(secret.toString("base64"), context("mfa_totp_secret")),
        options.email === false ? null : await encryptor.encrypt(`aminata.${userId}@example.test`, context("email")),
        options.email === false ? null : randomBytes(32),
      ],
    );
    const tier = options.tier ?? "tier_1";
    if (tier !== "tier_0") await grantKycTier(owner, userId, tier);
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
  async function quote(customer: Customer, fundingMethod: string, sourceAmount = 10000n, usdEquivalent: bigint | null = null): Promise<string> {
    const result = await owner.query<{ id: string }>(
      `INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                              funding_method, source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate,
                              margin_bps, usd_equivalent, expires_at)
       VALUES ($1, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', $2::transfers.funding_method, $3::bigint, 199, $3::bigint + 199,
               fx.convert_minor($3::bigint, 646.117645, 'EUR', 'XOF'), 655.957, 646.117645, 150, COALESCE($4::bigint, ($3::bigint * 108.69 / 100)::bigint),
               now() + interval '10 minutes')
       RETURNING id`,
      [customer.userId, fundingMethod, sourceAmount.toString(), usdEquivalent?.toString() ?? null],
    );
    return result.rows[0]!.id;
  }

  async function createTransfer(customer: Customer, body: Record<string, unknown>, key = `idem-${randomUUID()}`): Promise<request.Response> {
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

  async function postFlutterwave(payload: Record<string, unknown>, hash = FLW_HASH): Promise<request.Response> {
    return request(app).post("/v1/webhooks/flutterwave").set("Content-Type", "application/json").set("verif-hash", hash).send(JSON.stringify(payload));
  }

  async function postStripe(event: Record<string, unknown>, secret = STRIPE_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): Promise<request.Response> {
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", secret).update(`${timestamp.toString()}.${body}`).digest("hex");
    return request(app).post("/v1/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", `t=${timestamp.toString()},v1=${signature}`).send(body);
  }

  async function postThunes(payload: Record<string, unknown>): Promise<request.Response> {
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

  const setup = async (): Promise<void> => {
    await owner.query("UPDATE ref.countries SET can_send = true WHERE alpha2 = 'FR'");
    await owner.query("UPDATE ref.countries SET can_receive = true WHERE alpha2 = 'SN'");
    await owner.query("UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF')");
    await owner.query("UPDATE payments.providers SET is_enabled = true");
    const others = await owner.query<{ id: string }>("UPDATE payments.payout_corridors SET is_enabled = false WHERE destination_country = 'SN' AND is_enabled RETURNING id");
    disabledCorridors = others.rows.map((row) => row.id);
    await owner.query(
      `INSERT INTO payments.payout_corridors (source_country, destination_country, destination_currency, payout_method, provider, priority,
                                              min_amount, max_amount, cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled, provider_route_code)
       VALUES ('FR', 'SN', 'XOF', 'mobile_money', 'flutterwave', 10, 500, 5000000, 0, 50, 5, false, 'FMM'),
              ('FR', 'SN', 'XOF', 'mobile_money', 'thunes', 20, 500, 5000000, 300, 0, 30, false, '4021')
       ON CONFLICT DO NOTHING`,
    );
    const enabled = await owner.query<{ id: string }>(
      `UPDATE payments.payout_corridors SET is_enabled = true
        WHERE source_country = 'FR' AND destination_country = 'SN' AND destination_currency = 'XOF' AND payout_method = 'mobile_money'
          AND provider IN ('flutterwave', 'thunes')
        RETURNING id`,
    );
    corridorIds.push(...enabled.rows.map((row) => row.id));
    await loadScreeningLists();
    await owner.query(
      `INSERT INTO payments.payin_methods (country, currency, funding_method, provider, priority, min_amount, max_amount, cost_fixed, cost_bps, is_enabled)
       VALUES ('FR', 'EUR', 'card', 'stripe', 10, 100, 10000000, 25, 140, true),
              ('FR', 'EUR', 'bank_transfer', 'flutterwave', 10, 100, 10000000, 0, 100, true)
       ON CONFLICT (country, currency, funding_method, provider) DO UPDATE SET is_enabled = true`,
    );
    await fundFloat("flutterwave", 10_000_000n);
    await fundFloat("thunes", 10_000_000n);
  };

  const resetEach = async (): Promise<void> => {
    fake.reset();
    await owner.query("UPDATE payments.provider_health SET circuit_state = 'closed', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL");
  };

  const teardown = async (): Promise<void> => {
    await owner.query("UPDATE payments.payout_corridors SET is_enabled = false WHERE id = ANY($1::uuid[])", [corridorIds]);
    await owner.query("UPDATE payments.payout_corridors SET is_enabled = true WHERE id = ANY($1::uuid[])", [disabledCorridors]);
    await owner.query("UPDATE payments.provider_health SET circuit_state = 'closed', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL");
    await apiPool.end();
    await owner.end();
  };

  async function loadScreeningLists(): Promise<void> {
    const ingestion = new ListIngestionService(apiPool, silentLogger);
    await ingestion.refresh(staticListSource("test_sanctions", "sanctions", TEST_SANCTIONS));
    await ingestion.refresh(staticListSource("test_peps", "pep", TEST_PEPS));
  }

  return { keys, config, owner, apiPool, fake, encryptor, indexer, inbox, transfersModule, orchestrator, backoffice, app, verifiedCustomer, totp, addRecipient, quote, createTransfer, transferStatus, balance, journals, payoutAttempts, postFlutterwave, postStripe, postThunes, age, fundFloat, setup, resetEach, teardown, loadScreeningLists };
}

export type PaymentHarness = Awaited<ReturnType<typeof createPaymentHarness>>;
export type HarnessCustomer = Awaited<ReturnType<PaymentHarness["verifiedCustomer"]>>;
