import { generateKeyPairSync, randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { canonicalUrl, checkProviders, exitCodeOf, formatReport, STRIPE_REQUIRED_EVENTS } from "../src/cli/providerChecks.js";
import type { ProviderCheck } from "../src/cli/providerChecks.js";
import type { AppConfig } from "../src/config/env.js";
import { FLW_HASH, FLW_SECRET, STRIPE_PUBLISHABLE, STRIPE_SECRET, STRIPE_WEBHOOK_SECRET, THUNES_BASE, THUNES_KEY, THUNES_SECRET } from "./support/fakePayments.js";
import { buildTestConfig, createTestKeys } from "./support/fixtures.js";
import type { TestKeys } from "./support/fixtures.js";

const API = "https://api.transfertplus.test";
const ONFIDO_TOKEN = `api_sandbox.${"o".repeat(32)}`;
const ONFIDO_WEBHOOK_TOKEN = "w".repeat(32);
const OXR_APP_ID = "0123456789abcdef0123456789abcdef";
const TWILIO_SID = `AC${"1".repeat(32)}`;
const TWILIO_TOKEN = "s".repeat(32);
const TWILIO_SERVICE = `MG${"2".repeat(32)}`;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  type: "service_account",
  client_email: "play-integrity@transfertplus-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
};

const SECRETS = [STRIPE_SECRET, FLW_SECRET, THUNES_SECRET, ONFIDO_TOKEN, ONFIDO_WEBHOOK_TOKEN, OXR_APP_ID, TWILIO_TOKEN, "ya29.test"];

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Réseau simulé : chaque hôte (et préfixe de chemin) répond par un gestionnaire ; tout autre appel échoue. */
function network(handlers: Readonly<Record<string, Handler>>) {
  const requests: { readonly url: string; readonly method: string; readonly headers: Readonly<Record<string, string>> }[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input.toString());
    requests.push({ url: url.href, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string> });
    expect(init.redirect ?? "error").toBe("error");
    const key = Object.keys(handlers)
      .filter((prefix) => url.href.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new TypeError(`fetch failed: ${url.host}`);
    const handler = handlers[key];
    if (handler === undefined) throw new TypeError("fetch failed");
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const allStripeEvents = STRIPE_REQUIRED_EVENTS.map((group) => group[0] ?? "");

function healthyHandlers(overrides: Readonly<Record<string, Handler>> = {}): Record<string, Handler> {
  return {
    "https://api.stripe.com/v1/webhook_endpoints": () =>
      Response.json({ object: "list", has_more: false, data: [{ id: "we_1", url: `${API}/v1/webhooks/stripe/`, status: "enabled", enabled_events: allStripeEvents }] }),
    "https://api.flutterwave.com/v3/balances": () =>
      Response.json({ status: "success", data: [{ currency: "NGN", available_balance: 10, ledger_balance: 10 }, { currency: "USD", available_balance: 0, ledger_balance: 0 }] }),
    [`${THUNES_BASE}/v2/money-transfer/balances`]: () => Response.json([{ id: 1, currency: "USD", balance: 1000, pending: 0, credit_facility: 0 }]),
    "https://api.eu.onfido.com/v3.6/webhooks": () =>
      Response.json({
        webhooks: [
          { id: "wh-1", url: `${API}/v1/webhooks/onfido`, enabled: true, token: ONFIDO_WEBHOOK_TOKEN, events: ["workflow_run.completed"], environments: ["sandbox"] },
        ],
      }),
    "https://openexchangerates.org/api/usage.json": () =>
      Response.json({ status: 200, data: { app_id: OXR_APP_ID, status: "active", plan: { name: "Developer" } } }),
    "https://api.twilio.com/2010-04-01/Accounts/": () => Response.json({ sid: TWILIO_SID, status: "active", type: "Full" }),
    "https://messaging.twilio.com/v1/Services/": () => Response.json({ sid: TWILIO_SERVICE }),
    "https://oauth2.googleapis.com/token": () => Response.json({ access_token: "ya29.test", expires_in: 3600 }),
    "https://playintegrity.googleapis.com/": () => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 }),
    ...overrides,
  };
}

let keys: TestKeys;
let config: AppConfig;

beforeAll(async () => {
  keys = await createTestKeys();
  config = buildTestConfig(keys, {
    STRIPE_SECRET_KEY: STRIPE_SECRET,
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE,
    STRIPE_WEBHOOK_SECRET,
    FLUTTERWAVE_SECRET_KEY: FLW_SECRET,
    FLUTTERWAVE_WEBHOOK_HASH: FLW_HASH,
    FLUTTERWAVE_REDIRECT_URL: "https://app.transfertplus.test/paiement/retour",
    THUNES_BASE_URL: THUNES_BASE,
    THUNES_API_KEY: THUNES_KEY,
    THUNES_API_SECRET: THUNES_SECRET,
    THUNES_CALLBACK_URL: `${API}/v1/webhooks/thunes`,
    THUNES_CALLBACK_ALLOWED_IPS: "203.0.113.10",
    ONFIDO_API_TOKEN: ONFIDO_TOKEN,
    ONFIDO_WEBHOOK_TOKEN,
    ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
    ONFIDO_WORKFLOW_PROOF_OF_ADDRESS: "7a1e3b5f-8d2c-4e9f-8b4a-3c6d9f2e8b01",
    SMILE_ID_PARTNER_ID: "2343",
    SMILE_ID_API_KEY: "k".repeat(32),
    SMILE_ID_CALLBACK_URL: `${API}/v1/webhooks/smile-id`,
    OPEN_EXCHANGE_RATES_APP_ID: OXR_APP_ID,
    FX_PRIMARY_PROVIDER: "open_exchange_rates",
    SMS_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: TWILIO_SID,
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID: TWILIO_SERVICE,
    ANDROID_PACKAGE_NAME: "com.transfertplus.app",
    ANDROID_SIGNING_CERT_SHA256: randomBytes(32).toString("base64url"),
    GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT: JSON.stringify(serviceAccount),
  });
});

function byName(checks: readonly ProviderCheck[], name: string): ProviderCheck {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`contrôle ${name} absent`);
  return check;
}

describe("contrôle des comptes prestataires", () => {
  it("comptes sains : chaque prestataire est interrogé en lecture seule, sans secret dans le rapport", async () => {
    const { fetchImpl, requests } = network(healthyHandlers());
    const checks = await checkProviders({ config, apiOrigin: API, fetchImpl });

    expect(byName(checks, "Stripe").status).toBe("ok");
    expect(byName(checks, "Onfido").status).toBe("ok");
    expect(byName(checks, "Thunes").status).toBe("ok");
    expect(byName(checks, "Open Exchange Rates").status).toBe("ok");
    expect(byName(checks, "Twilio (SMS)").status).toBe("ok");
    expect(byName(checks, "Play Integrity").status).toBe("ok");
    // Ce qui n'est pas vérifiable par API est signalé, jamais présumé correct.
    expect(byName(checks, "Flutterwave").status).toBe("warning");
    expect(byName(checks, "Flutterwave").details.join(" ")).toContain(`${API}/v1/webhooks/flutterwave`);
    expect(byName(checks, "Smile ID").status).toBe("warning");
    expect(byName(checks, "Fixer").status).toBe("not_configured");
    expect(byName(checks, "Horodatage RFC 3161").status).toBe("not_configured");
    expect(exitCodeOf(checks, false)).toBe(0);
    expect(exitCodeOf(checks, true)).toBe(1);

    // Lecture seule : aucun appel mutateur chez un prestataire de paiement, de KYC ou de SMS.
    const mutating = requests.filter((request) => request.method !== "GET").map((request) => new URL(request.url).host);
    expect(new Set(mutating)).toEqual(new Set(["oauth2.googleapis.com", "playintegrity.googleapis.com"]));
    expect(requests.find((request) => request.url.startsWith("https://api.stripe.com"))?.headers["Authorization"]).toBe(`Bearer ${STRIPE_SECRET}`);

    const report = `${formatReport(checks)}\n${JSON.stringify(checks)}`;
    for (const secret of SECRETS) expect(report).not.toContain(secret);
  });

  it("Stripe : endpoint absent, désactivé, événements manquants ou en double", async () => {
    const missing = network(healthyHandlers({ "https://api.stripe.com/v1/webhook_endpoints": () => Response.json({ data: [{ id: "we_9", url: "https://ailleurs.test/hook", status: "enabled", enabled_events: ["*"] }] }) }));
    const absent = byName(await checkProviders({ config, apiOrigin: API, fetchImpl: missing.fetchImpl }), "Stripe");
    expect(absent.status).toBe("failed");
    expect(absent.details.join(" ")).toContain(`aucun endpoint de webhook test vers ${API}/v1/webhooks/stripe`);

    const partial = network(
      healthyHandlers({
        "https://api.stripe.com/v1/webhook_endpoints": () =>
          Response.json({
            data: [
              { id: "we_1", url: `${API}/v1/webhooks/stripe`, status: "enabled", enabled_events: ["payment_intent.succeeded", "charge.refund.updated"] },
              { id: "we_2", url: `${API}/v1/webhooks/stripe`, status: "disabled", enabled_events: ["*"] },
            ],
          }),
      }),
    );
    const flawed = byName(await checkProviders({ config, apiOrigin: API, fetchImpl: partial.fetchImpl }), "Stripe");
    expect(flawed.status).toBe("failed");
    const text = flawed.details.join("\n");
    expect(text).toContain("2 endpoints vers la même URL");
    expect(text).toContain("endpoint we_2 désactivé");
    expect(text).toContain("payment_intent.payment_failed");
    expect(text).toContain("charge.dispute.funds_withdrawn");
    // charge.refund.updated satisfait le groupe des remboursements.
    expect(text).not.toContain("refund.updated ou charge.refund.updated");

    const wildcard = network(
      healthyHandlers({ "https://api.stripe.com/v1/webhook_endpoints": () => Response.json({ data: [{ id: "we_3", url: `${API}/v1/webhooks/stripe`, status: "enabled", enabled_events: ["*"] }] }) }),
    );
    expect(byName(await checkProviders({ config, apiOrigin: API, fetchImpl: wildcard.fetchImpl }), "Stripe").status).toBe("ok");
  });

  it("identifiants refusés, droits insuffisants et prestataire injoignable : échec explicite sans exception", async () => {
    const { fetchImpl } = network(
      healthyHandlers({
        "https://api.stripe.com/v1/webhook_endpoints": () => Response.json({ error: { type: "invalid_request_error" } }, { status: 401 }),
        "https://api.eu.onfido.com/v3.6/webhooks": () => Response.json({}, { status: 403 }),
        "https://api.flutterwave.com/v3/balances": () => {
          throw new TypeError("fetch failed");
        },
        // Refus d'un proxy sortant (page HTML) : jamais présenté comme un refus du prestataire.
        "https://openexchangerates.org/api/usage.json": () => new Response("<html>Forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } }),
      }),
    );
    const checks = await checkProviders({ config, apiOrigin: API, fetchImpl });
    expect(byName(checks, "Stripe")).toMatchObject({ status: "failed", details: ["HTTP 401 : identifiants refusés"] });
    expect(byName(checks, "Onfido")).toMatchObject({ status: "failed", details: ["HTTP 403 : droits insuffisants"] });
    expect(byName(checks, "Flutterwave")).toMatchObject({ status: "failed", details: ["injoignable (TypeError)"] });
    expect(byName(checks, "Open Exchange Rates")).toMatchObject({
      status: "failed",
      details: ["HTTP 403 non émis par le prestataire (réponse non JSON : proxy ou pare-feu sortant ?)"],
    });
    expect(exitCodeOf(checks, false)).toBe(1);
  });

  it("Onfido : jeton de webhook, événement et environnement concordants exigés", async () => {
    const { fetchImpl } = network(
      healthyHandlers({
        "https://api.eu.onfido.com/v3.6/webhooks": () =>
          Response.json({
            webhooks: [{ id: "wh-2", url: `${API}/v1/webhooks/onfido`, enabled: true, token: "x".repeat(32), events: ["check.completed"], environments: ["live"] }],
          }),
      }),
    );
    const onfido = byName(await checkProviders({ config, apiOrigin: API, fetchImpl }), "Onfido");
    expect(onfido.status).toBe("failed");
    expect(onfido.details.join(" ")).toContain("webhook wh-2 : événement workflow_run.completed absent, environnement sandbox absent, jeton différent de ONFIDO_WEBHOOK_TOKEN");
  });

  it("Thunes : devise de préfinancement absente, rappels mal dirigés, liste d'adresses vide", async () => {
    const misdirected = buildTestConfig(keys, {
      THUNES_BASE_URL: THUNES_BASE,
      THUNES_API_KEY: THUNES_KEY,
      THUNES_API_SECRET: THUNES_SECRET,
      THUNES_CALLBACK_URL: "https://ancienne-api.transfertplus.test/v1/webhooks/thunes",
      THUNES_SETTLEMENT_CURRENCY: "EUR",
    });
    const { fetchImpl, requests } = network(healthyHandlers());
    const thunes = byName(await checkProviders({ config: misdirected, apiOrigin: API, fetchImpl }), "Thunes");
    expect(thunes.status).toBe("failed");
    const text = thunes.details.join("\n");
    expect(text).toContain("aucun compte de préfinancement en EUR");
    expect(text).toContain(`THUNES_CALLBACK_URL ne désigne pas ${API}/v1/webhooks/thunes`);
    expect(text).toContain("THUNES_CALLBACK_ALLOWED_IPS vide");
    const thunesRequest = requests.find((request) => request.url.startsWith(THUNES_BASE));
    expect(thunesRequest?.headers["Authorization"]).toBe(`Basic ${Buffer.from(`${THUNES_KEY}:${THUNES_SECRET}`).toString("base64")}`);
  });

  it("Twilio et Play Integrity : compte d'essai signalé, projet Google non lié refusé", async () => {
    const { fetchImpl } = network(
      healthyHandlers({
        "https://api.twilio.com/2010-04-01/Accounts/": () => Response.json({ sid: TWILIO_SID, status: "active", type: "Trial" }),
        "https://playintegrity.googleapis.com/": () => Response.json({ error: { code: 403, status: "PERMISSION_DENIED" } }, { status: 403 }),
      }),
    );
    const checks = await checkProviders({ config, apiOrigin: API, fetchImpl });
    expect(byName(checks, "Twilio (SMS)").status).toBe("warning");
    expect(byName(checks, "Twilio (SMS)").details[0]).toContain("ESSAI");
    const play = byName(checks, "Play Integrity");
    expect(play.status).toBe("failed");
    expect(play.details[0]).toContain("HTTP 403");
    expect(play.details[0]).toContain("com.transfertplus.app");
  });

  it("réponses illisibles, webhooks absents, rappels mal dirigés et options de développement", async () => {
    const variant = buildTestConfig(keys, {
      STRIPE_SECRET_KEY: STRIPE_SECRET,
      STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE,
      STRIPE_WEBHOOK_SECRET,
      THUNES_BASE_URL: THUNES_BASE,
      THUNES_API_KEY: THUNES_KEY,
      THUNES_API_SECRET: THUNES_SECRET,
      THUNES_CALLBACK_URL: `${API}/v1/webhooks/thunes`,
      THUNES_CALLBACK_ALLOWED_IPS: "203.0.113.10",
      ONFIDO_API_TOKEN: ONFIDO_TOKEN,
      ONFIDO_WEBHOOK_TOKEN,
      ONFIDO_WORKFLOW_DOCUMENT_VERIFICATION: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
      SMILE_ID_PARTNER_ID: "2343",
      SMILE_ID_API_KEY: "k".repeat(32),
      SMILE_ID_CALLBACK_URL: "https://ancienne-api.transfertplus.test/v1/webhooks/smile-id",
      FIXER_API_KEY: "F".repeat(32),
      FX_PRIMARY_PROVIDER: "fixer",
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: TWILIO_SID,
      TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TWILIO_MESSAGING_SERVICE_SID: TWILIO_SERVICE,
      APPLE_APP_ATTEST_APP_IDS: "ABCDE12345.com.transfertplus.app",
      APPLE_APP_ATTEST_ALLOW_DEVELOPMENT: "true",
    });
    const publishedAt = Math.floor(Date.now() / 1000) - 120;
    const { fetchImpl, requests } = network(
      healthyHandlers({
        "https://api.stripe.com/v1/webhook_endpoints": () => Response.json({ object: "list" }),
        [`${THUNES_BASE}/v2/money-transfer/balances`]: () => Response.json({ balances: [] }),
        "https://api.eu.onfido.com/v3.6/webhooks": () => Response.json({ webhooks: [] }),
        "https://api.apilayer.com/fixer/latest": () =>
          new Response(`{"success":true,"base":"USD","timestamp":${publishedAt.toString()},"rates":{"EUR":0.921456,"XOF":604.5}}`, {
            headers: { "Content-Type": "application/json" },
          }),
        "https://messaging.twilio.com/v1/Services/": () => Response.json({ code: 20404 }, { status: 404 }),
      }),
    );
    const checks = await checkProviders({ config: variant, apiOrigin: API, fetchImpl });

    expect(byName(checks, "Stripe")).toMatchObject({ status: "failed", details: ["liste des endpoints illisible"] });
    expect(byName(checks, "Thunes")).toMatchObject({ status: "failed", details: ["réponse des soldes illisible"] });
    expect(byName(checks, "Onfido").status).toBe("failed");
    expect(byName(checks, "Onfido").details.join(" ")).toContain(`aucun webhook vers ${API}/v1/webhooks/onfido`);
    expect(byName(checks, "Smile ID").status).toBe("failed");
    expect(byName(checks, "Smile ID").details.join(" ")).toContain(`SMILE_ID_CALLBACK_URL ne désigne pas ${API}/v1/webhooks/smile-id`);
    expect(byName(checks, "Fixer")).toMatchObject({ status: "ok", details: ["2 taux reçus, publiés il y a 2 min (source principale)"] });
    expect(requests.find((request) => request.url.startsWith("https://api.apilayer.com"))?.headers["apikey"]).toBe("F".repeat(32));
    expect(byName(checks, "Open Exchange Rates").status).toBe("not_configured");
    expect(byName(checks, "Twilio (SMS)")).toMatchObject({ status: "failed", details: ["HTTP 404 : Messaging Service introuvable sur ce compte"] });
    expect(byName(checks, "App Attest").status).toBe("warning");
    expect(byName(checks, "App Attest").details.join(" ")).toContain("ABCDE12345.com.transfertplus.app");
    expect(byName(checks, "Play Integrity").status).toBe("not_configured");
    expect(byName(checks, "Flutterwave").status).toBe("not_configured");
  });

  it("Twilio : compte suspendu refusé ; SMS désactivé signalé", async () => {
    const { fetchImpl } = network(healthyHandlers({ "https://api.twilio.com/2010-04-01/Accounts/": () => Response.json({ sid: TWILIO_SID, status: "suspended", type: "Full" }) }));
    expect(byName(await checkProviders({ config, apiOrigin: API, fetchImpl }), "Twilio (SMS)")).toMatchObject({ status: "failed", details: ["compte suspended"] });

    const withoutSms = buildTestConfig(keys);
    const quiet = network({});
    const checks = await checkProviders({ config: withoutSms, apiOrigin: API, fetchImpl: quiet.fetchImpl });
    expect(byName(checks, "Twilio (SMS)")).toMatchObject({ status: "not_configured", details: ["SMS_PROVIDER=log : aucun SMS n'est envoyé"] });
    // Rien de configuré : aucun appel réseau, aucun échec.
    expect(quiet.requests).toHaveLength(0);
    expect(checks.every((check) => check.status === "not_configured")).toBe(true);
    expect(exitCodeOf(checks, true)).toBe(0);
  });

  it("URL de webhook canoniques (barre finale, casse de l'hôte, fragment)", () => {
    expect(canonicalUrl("https://API.TransfertPlus.test/v1/webhooks/stripe/")).toBe("https://api.transfertplus.test/v1/webhooks/stripe");
    expect(canonicalUrl("https://api.transfertplus.test/v1/webhooks/onfido#x")).toBe("https://api.transfertplus.test/v1/webhooks/onfido");
    expect(canonicalUrl("https://api.transfertplus.test/")).toBe("https://api.transfertplus.test/");
  });
});
