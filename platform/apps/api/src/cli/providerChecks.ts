import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AppConfig } from "../config/env.js";
import { parsePemBundle, TimestampAuthorityClient } from "../lib/crypto/rfc3161.js";
import { PlayIntegrityVerifier } from "../modules/auth/attestation/playIntegrity.js";
import { FixerClient } from "../modules/fx/providers/fixer.client.js";

/**
 * Contrôle des comptes prestataires avant une mise en service (sandbox puis
 * live) : chaque prestataire configuré est interrogé en LECTURE SEULE avec les
 * identifiants de la configuration, et ce qui se vérifie à distance l'est
 * (webhooks enregistrés vers l'URL publique de l'API, événements abonnés, jeton
 * de webhook, environnement test/live, solde de préfinancement). Aucun secret
 * n'est jamais restitué : seuls des statuts HTTP, des codes d'erreur et des
 * éléments non sensibles (devises, nom de plan) figurent dans le rapport.
 *
 * Ce qui ne peut pas être vérifié par API est signalé explicitement (statut
 * « warning »), jamais présumé correct.
 */

export type CheckStatus = "ok" | "warning" | "failed" | "not_configured";

export interface ProviderCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly details: readonly string[];
}

export interface ProviderCheckOptions {
  readonly config: AppConfig;
  /** Origine publique de l'API (https://api.exemple.com), d'où sont déduites les URL de webhook attendues. */
  readonly apiOrigin: string;
  readonly fetchImpl?: typeof fetch;
}

/** Événements Stripe traités par /v1/webhooks/stripe ; chaque groupe exige au moins l'un de ses événements. */
export const STRIPE_REQUIRED_EVENTS: readonly (readonly string[])[] = [
  ["payment_intent.succeeded"],
  ["payment_intent.payment_failed"],
  ["payment_intent.canceled"],
  ["payment_intent.processing"],
  ["payment_intent.requires_action"],
  ["refund.updated", "charge.refund.updated"],
  ["charge.dispute.funds_withdrawn"],
  ["charge.dispute.funds_reinstated"],
];

export const ONFIDO_REQUIRED_EVENT = "workflow_run.completed";

const REQUEST_TIMEOUT_MS = 15_000;

type JsonObject = Readonly<Record<string, unknown>>;

class CheckFailure extends Error {
  override readonly name = "CheckFailure";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

function stringArrayOf(object: JsonObject, key: string): readonly string[] {
  const value = object[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Forme canonique d'une URL de webhook (hôte en minuscules, sans barre finale, sans fragment). */
export function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  const text = url.href;
  return text.endsWith("/") && url.pathname !== "/" ? text.slice(0, -1) : text;
}

export function expectedWebhookUrl(apiOrigin: string, path: `/v1/webhooks/${string}`): string {
  return canonicalUrl(new URL(path, apiOrigin).href);
}

function sameSecret(a: string, b: string): boolean {
  // Comparaison à durée constante sur des condensats de longueur fixe.
  return timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly method?: "GET"; readonly headers: Readonly<Record<string, string>> },
): Promise<{ readonly status: number; readonly body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new CheckFailure(`injoignable (${error instanceof Error ? error.name : "erreur réseau"})`);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

/**
 * Échec HTTP. Un prestataire répond en JSON : une réponse d'un autre format
 * vient d'un intermédiaire (proxy ou pare-feu sortant), et l'interpréter comme
 * un refus du prestataire égarerait le diagnostic.
 */
function httpFailure(response: { readonly status: number; readonly body: unknown }, meaning: Readonly<Partial<Record<number, string>>> = {}): CheckFailure {
  const status = response.status.toString();
  if (response.body === null) return new CheckFailure(`HTTP ${status} non émis par le prestataire (réponse non JSON : proxy ou pare-feu sortant ?)`);
  const explanation = meaning[response.status] ?? (response.status === 401 ? "identifiants refusés" : response.status === 403 ? "droits insuffisants" : "réponse inattendue");
  return new CheckFailure(`HTTP ${status} : ${explanation}`);
}

async function run(name: string, check: () => Promise<{ readonly status: CheckStatus; readonly details: readonly string[] }>): Promise<ProviderCheck> {
  try {
    const result = await check();
    return { name, ...result };
  } catch (error: unknown) {
    const message = error instanceof CheckFailure ? error.message : error instanceof Error ? `${error.name} : ${error.message}` : "erreur inconnue";
    return { name, status: "failed", details: [message.slice(0, 300)] };
  }
}

function notConfigured(name: string, variables: string): ProviderCheck {
  return { name, status: "not_configured", details: [`non configuré (${variables})`] };
}

/** Garde la pire issue entre plusieurs constats (failed > warning > ok). */
function worst(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("warning")) return "warning";
  return "ok";
}

async function checkStripe(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const stripe = options.config.payments.stripe;
  if (stripe === undefined) return notConfigured("Stripe", "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET");
  return run("Stripe", async () => {
    const expected = expectedWebhookUrl(options.apiOrigin, "/v1/webhooks/stripe");
    const mode = stripe.secretKey.includes("_live_") ? "live" : "test";
    const response = await requestJson(fetchImpl, "https://api.stripe.com/v1/webhook_endpoints?limit=100", {
      headers: { Authorization: `Bearer ${stripe.secretKey}`, "Stripe-Version": stripe.apiVersion },
    });
    if (response.status !== 200) throw httpFailure(response, { 403: "clé restreinte sans droit de lecture des endpoints de webhook" });
    const body = response.body;
    if (!isObject(body) || !Array.isArray(body["data"])) throw new CheckFailure("liste des endpoints illisible");
    const endpoints = body["data"].filter(isObject).filter((endpoint) => {
      const url = stringOf(endpoint, "url");
      return url !== null && canonicalUrl(url) === expected;
    });
    const details = [`clé ${mode} acceptée`];
    const statuses: CheckStatus[] = [];
    if (endpoints.length === 0) {
      return { status: "failed", details: [...details, `aucun endpoint de webhook ${mode} vers ${expected}`] };
    }
    if (endpoints.length > 1) {
      statuses.push("warning");
      details.push(`${endpoints.length.toString()} endpoints vers la même URL : un seul secret (STRIPE_WEBHOOK_SECRET) est vérifié, les événements des autres seront rejetés`);
    }
    for (const endpoint of endpoints) {
      const id = stringOf(endpoint, "id") ?? "?";
      if (stringOf(endpoint, "status") !== "enabled") {
        statuses.push("failed");
        details.push(`endpoint ${id} désactivé`);
        continue;
      }
      const events = new Set(stringArrayOf(endpoint, "enabled_events"));
      const missing = events.has("*") ? [] : STRIPE_REQUIRED_EVENTS.filter((group) => !group.some((event) => events.has(event)));
      if (missing.length > 0) {
        statuses.push("failed");
        details.push(`endpoint ${id} : événements manquants ${missing.map((group) => group.join(" ou ")).join(", ")}`);
      } else {
        details.push(`endpoint ${id} actif vers ${expected}, événements requis abonnés`);
      }
    }
    details.push("secret de signature : vérifié à la réception du premier événement (Stripe ne le restitue pas par API)");
    return { status: worst(statuses), details };
  });
}

async function checkFlutterwave(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const flutterwave = options.config.payments.flutterwave;
  if (flutterwave === undefined) return notConfigured("Flutterwave", "FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_HASH, FLUTTERWAVE_REDIRECT_URL");
  return run("Flutterwave", async () => {
    const mode = flutterwave.secretKey.startsWith("FLWSECK_TEST") ? "test" : "live";
    const response = await requestJson(fetchImpl, "https://api.flutterwave.com/v3/balances", {
      headers: { Authorization: `Bearer ${flutterwave.secretKey}` },
    });
    if (response.status !== 200) throw httpFailure(response);
    const body = response.body;
    if (!isObject(body) || body["status"] !== "success" || !Array.isArray(body["data"])) throw new CheckFailure("réponse des soldes illisible");
    const currencies = body["data"].filter(isObject).map((balance) => stringOf(balance, "currency")).filter((currency): currency is string => currency !== null);
    return {
      status: "warning",
      details: [
        `clé ${mode} acceptée ; portefeuilles : ${currencies.length === 0 ? "aucun" : currencies.join(", ")}`,
        `à contrôler dans le tableau de bord (non exposé par l'API) : URL de webhook ${expectedWebhookUrl(options.apiOrigin, "/v1/webhooks/flutterwave")} et « secret hash » égal à FLUTTERWAVE_WEBHOOK_HASH`,
      ],
    };
  });
}

async function checkThunes(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const thunes = options.config.payments.thunes;
  if (thunes === undefined) return notConfigured("Thunes", "THUNES_BASE_URL, THUNES_API_KEY, THUNES_API_SECRET, THUNES_CALLBACK_URL");
  return run("Thunes", async () => {
    const authorization = `Basic ${Buffer.from(`${thunes.apiKey}:${thunes.apiSecret}`, "utf8").toString("base64")}`;
    const response = await requestJson(fetchImpl, `${thunes.baseUrl}/v2/money-transfer/balances`, { headers: { Authorization: authorization } });
    if (response.status !== 200) throw httpFailure(response);
    const body = response.body;
    if (!Array.isArray(body)) throw new CheckFailure("réponse des soldes illisible");
    const currencies = body.filter(isObject).map((balance) => stringOf(balance, "currency")).filter((currency): currency is string => currency !== null);
    const statuses: CheckStatus[] = [];
    const details = [`identifiants acceptés ; comptes de préfinancement : ${currencies.length === 0 ? "aucun" : currencies.join(", ")}`];
    if (!currencies.includes(thunes.settlementCurrency)) {
      statuses.push("failed");
      details.push(`aucun compte de préfinancement en ${thunes.settlementCurrency} (THUNES_SETTLEMENT_CURRENCY) : les cotations échoueront`);
    }
    const expected = expectedWebhookUrl(options.apiOrigin, "/v1/webhooks/thunes");
    if (canonicalUrl(thunes.callbackUrl) === expected) {
      details.push(`rappels envoyés vers ${expected}`);
    } else {
      statuses.push("failed");
      details.push(`THUNES_CALLBACK_URL ne désigne pas ${expected} : les rappels n'atteindront pas l'API`);
    }
    if (thunes.callbackAllowedIps.length === 0) {
      statuses.push("warning");
      details.push("THUNES_CALLBACK_ALLOWED_IPS vide : rappels acceptés de toute adresse (l'état est toujours relu chez Thunes, mais renseigner les adresses communiquées par Thunes)");
    }
    return { status: worst(statuses), details };
  });
}

async function checkOnfido(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const onfido = options.config.kyc.onfido;
  if (onfido === undefined) return notConfigured("Onfido", "ONFIDO_API_TOKEN, ONFIDO_WEBHOOK_TOKEN");
  return run("Onfido", async () => {
    const environment = onfido.apiToken.startsWith("api_live") ? "live" : "sandbox";
    const expected = expectedWebhookUrl(options.apiOrigin, "/v1/webhooks/onfido");
    const response = await requestJson(fetchImpl, `${onfido.baseUrl}/webhooks`, {
      headers: { Authorization: `Token token=${onfido.apiToken}` },
    });
    if (response.status !== 200) throw httpFailure(response);
    const body = response.body;
    if (!isObject(body) || !Array.isArray(body["webhooks"])) throw new CheckFailure("liste des webhooks illisible");
    const webhooks = body["webhooks"].filter(isObject).filter((webhook) => {
      const url = stringOf(webhook, "url");
      return url !== null && canonicalUrl(url) === expected;
    });
    const details = [`jeton ${environment} accepté (région ${new URL(onfido.baseUrl).hostname})`];
    if (webhooks.length === 0) return { status: "failed", details: [...details, `aucun webhook vers ${expected}`] };
    const usable = webhooks.filter((webhook) => {
      const token = stringOf(webhook, "token");
      return (
        webhook["enabled"] === true
        && stringArrayOf(webhook, "events").includes(ONFIDO_REQUIRED_EVENT)
        && stringArrayOf(webhook, "environments").includes(environment)
        && token !== null
        && sameSecret(token, onfido.webhookToken)
      );
    });
    if (usable.length === 0) {
      const reasons = webhooks.map((webhook) => {
        const problems: string[] = [];
        if (webhook["enabled"] !== true) problems.push("désactivé");
        if (!stringArrayOf(webhook, "events").includes(ONFIDO_REQUIRED_EVENT)) problems.push(`événement ${ONFIDO_REQUIRED_EVENT} absent`);
        if (!stringArrayOf(webhook, "environments").includes(environment)) problems.push(`environnement ${environment} absent`);
        const token = stringOf(webhook, "token");
        if (token === null || !sameSecret(token, onfido.webhookToken)) problems.push("jeton différent de ONFIDO_WEBHOOK_TOKEN");
        return `webhook ${stringOf(webhook, "id") ?? "?"} : ${problems.join(", ")}`;
      });
      return { status: "failed", details: [...details, ...reasons] };
    }
    const missingWorkflows = Object.entries(onfido.workflows).filter(([, id]) => id === undefined).map(([kind]) => kind);
    return {
      status: missingWorkflows.length === 0 ? "ok" : "warning",
      details: [
        ...details,
        `webhook actif vers ${expected} (${ONFIDO_REQUIRED_EVENT}, ${environment}, jeton concordant)`,
        ...(missingWorkflows.length === 0 ? [] : [`workflow non configuré : ${missingWorkflows.join(", ")}`]),
      ],
    };
  });
}

function checkSmileId(options: ProviderCheckOptions): ProviderCheck {
  const smile = options.config.kyc.smileId;
  if (smile === undefined) return notConfigured("Smile ID", "SMILE_ID_PARTNER_ID, SMILE_ID_API_KEY, SMILE_ID_CALLBACK_URL");
  const expected = expectedWebhookUrl(options.apiOrigin, "/v1/webhooks/smile-id");
  const callbackOk = canonicalUrl(smile.callbackUrl) === expected;
  return {
    name: "Smile ID",
    status: callbackOk ? "warning" : "failed",
    details: [
      `environnement ${smile.environment} (${new URL(smile.baseUrl).hostname})`,
      callbackOk ? `rappels envoyés vers ${expected}` : `SMILE_ID_CALLBACK_URL ne désigne pas ${expected} : les résultats n'atteindront pas l'API`,
      "identifiants non vérifiables sans créer de vérification : valider par un parcours KYC de test de bout en bout",
    ],
  };
}

async function checkRates(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck[]> {
  const { openExchangeRatesAppId, fixerApiKey, primaryProvider } = options.config.fx;
  const checks: Promise<ProviderCheck>[] = [];
  if (openExchangeRatesAppId === undefined) {
    checks.push(Promise.resolve(notConfigured("Open Exchange Rates", "OPEN_EXCHANGE_RATES_APP_ID")));
  } else {
    checks.push(
      run("Open Exchange Rates", async () => {
        // usage.json ne consomme pas de quota.
        const response = await requestJson(fetchImpl, `https://openexchangerates.org/api/usage.json?app_id=${encodeURIComponent(openExchangeRatesAppId)}`, { headers: {} });
        if (response.status !== 200) throw httpFailure(response);
        const body = response.body;
        const data = isObject(body) && isObject(body["data"]) ? body["data"] : null;
        if (data === null) throw new CheckFailure("réponse d'usage illisible");
        const plan = isObject(data["plan"]) ? stringOf(data["plan"], "name") : null;
        if (stringOf(data, "status") !== "active") return { status: "failed", details: [`identifiant non actif (${stringOf(data, "status") ?? "statut inconnu"})`] };
        return { status: "ok", details: [`identifiant actif${plan === null ? "" : `, offre ${plan}`}${primaryProvider === "open_exchange_rates" ? " (source principale)" : ""}`] };
      }),
    );
  }
  if (fixerApiKey === undefined) {
    checks.push(Promise.resolve(notConfigured("Fixer", "FIXER_API_KEY")));
  } else {
    checks.push(
      run("Fixer", async () => {
        // Même lecture que la collecte réelle (une requête de quota).
        const rates = await new FixerClient(fixerApiKey, fetchImpl).fetchLatest();
        const ageMinutes = Math.round((Date.now() - rates.timestamp.getTime()) / 60_000);
        return {
          status: "ok",
          details: [`${rates.rates.size.toString()} taux reçus, publiés il y a ${ageMinutes.toString()} min${primaryProvider === "fixer" ? " (source principale)" : ""}`],
        };
      }),
    );
  }
  return Promise.all(checks);
}

async function checkTwilio(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const sms = options.config.auth.sms;
  if (sms.provider !== "twilio") {
    return { name: "Twilio (SMS)", status: options.config.isProduction ? "failed" : "not_configured", details: ["SMS_PROVIDER=log : aucun SMS n'est envoyé"] };
  }
  return run("Twilio (SMS)", async () => {
    const authorization = `Basic ${Buffer.from(`${sms.accountSid}:${sms.authToken}`, "utf8").toString("base64")}`;
    const account = await requestJson(fetchImpl, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sms.accountSid)}.json`, {
      headers: { Authorization: authorization },
    });
    if (account.status !== 200) throw httpFailure(account);
    if (!isObject(account.body)) throw new CheckFailure("compte illisible");
    const accountStatus = stringOf(account.body, "status");
    if (accountStatus !== "active") return { status: "failed", details: [`compte ${accountStatus ?? "de statut inconnu"}`] };
    const service = await requestJson(fetchImpl, `https://messaging.twilio.com/v1/Services/${encodeURIComponent(sms.messagingServiceSid)}`, {
      headers: { Authorization: authorization },
    });
    if (service.status !== 200) throw httpFailure(service, { 404: "Messaging Service introuvable sur ce compte" });
    const trial = stringOf(account.body, "type") === "Trial";
    return {
      status: trial && options.config.isProduction ? "failed" : trial ? "warning" : "ok",
      details: [
        `compte actif${trial ? " d'ESSAI (SMS limités aux numéros vérifiés)" : ""}`,
        `Messaging Service ${sms.messagingServiceSid.slice(0, 6)}… trouvé`,
      ],
    };
  });
}

async function checkPlayIntegrity(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const play = options.config.auth.playIntegrity;
  if (play === undefined) return notConfigured("Play Integrity", "ANDROID_PACKAGE_NAME, ANDROID_SIGNING_CERT_SHA256, GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT");
  return run("Play Integrity", async () => {
    const verifier = new PlayIntegrityVerifier({
      packageName: play.packageName,
      certificateDigests: play.certificateDigests,
      serviceAccount: play.serviceAccount,
      fetchImpl,
    });
    const access = await verifier.checkAccess();
    if (!access.authorized) {
      throw new CheckFailure(
        `décodage refusé (HTTP ${access.httpStatus.toString()}) : lier le projet Google Cloud du compte de service à ${play.packageName} dans la Play Console et y activer l'API Play Integrity`,
      );
    }
    return {
      status: "ok",
      details: [`compte de service ${play.serviceAccount.client_email} autorisé pour ${play.packageName}`, `${play.certificateDigests.length.toString()} empreinte(s) de certificat de signature acceptée(s)`],
    };
  });
}

function checkAppAttest(options: ProviderCheckOptions): ProviderCheck {
  const attest = options.config.auth.appAttest;
  if (attest === undefined) return notConfigured("App Attest", "APPLE_APP_ATTEST_APP_IDS");
  return {
    name: "App Attest",
    status: attest.allowDevelopment ? "warning" : "ok",
    details: [
      `App ID acceptés : ${attest.appIds.join(", ")} (racine Apple épinglée, aucun appel réseau)`,
      ...(attest.allowDevelopment ? ["environnement de développement App Attest accepté (interdit en production)"] : []),
    ],
  };
}

async function checkTimestampAuthority(options: ProviderCheckOptions, fetchImpl: typeof fetch): Promise<ProviderCheck> {
  const tsa = options.config.ledger.timestampAuthority;
  if (tsa === undefined) return notConfigured("Horodatage RFC 3161", "TSA_URL, TSA_TRUSTED_CERTS_PATH");
  return run("Horodatage RFC 3161", async () => {
    const client = new TimestampAuthorityClient(tsa.url, parsePemBundle(tsa.trustedCertsPem), fetchImpl);
    // Condensat aléatoire : jeton complet vérifié (empreinte, nonce, signature, chaîne de confiance).
    const stamp = await client.timestamp(createHash("sha256").update(randomBytes(32)).digest());
    return { status: "ok", details: [`jeton vérifié, émis le ${stamp.genTime.toISOString()} par ${stamp.signerSubject}`] };
  });
}

export async function checkProviders(options: ProviderCheckOptions): Promise<readonly ProviderCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [stripe, flutterwave, thunes, onfido, rates, twilio, playIntegrity, tsa] = await Promise.all([
    checkStripe(options, fetchImpl),
    checkFlutterwave(options, fetchImpl),
    checkThunes(options, fetchImpl),
    checkOnfido(options, fetchImpl),
    checkRates(options, fetchImpl),
    checkTwilio(options, fetchImpl),
    checkPlayIntegrity(options, fetchImpl),
    checkTimestampAuthority(options, fetchImpl),
  ]);
  return [stripe, flutterwave, thunes, onfido, checkSmileId(options), ...rates, twilio, playIntegrity, checkAppAttest(options), tsa];
}

/** Code de sortie : 1 si un contrôle a échoué (ou un avertissement en mode strict), 0 sinon. */
export function exitCodeOf(checks: readonly ProviderCheck[], strict: boolean): number {
  return checks.some((check) => check.status === "failed" || (strict && check.status === "warning")) ? 1 : 0;
}

const SYMBOLS: Readonly<Record<CheckStatus, string>> = { ok: "OK  ", warning: "ATTN", failed: "KO  ", not_configured: "--  " };

export function formatReport(checks: readonly ProviderCheck[]): string {
  return checks
    .map((check) => [`[${SYMBOLS[check.status]}] ${check.name}`, ...check.details.map((detail) => `         ${detail}`)].join("\n"))
    .join("\n");
}
