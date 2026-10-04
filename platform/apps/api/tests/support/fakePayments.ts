import { randomBytes } from "node:crypto";

/**
 * Faux prestataires de paiement (API HTTP en mémoire) : Stripe, Flutterwave,
 * Thunes. Les vrais clients de l'API sont exercés contre eux.
 */

export const STRIPE_SECRET = `sk_test_${"a".repeat(24)}`;
export const STRIPE_PUBLISHABLE = `pk_test_${"b".repeat(24)}`;
export const STRIPE_WEBHOOK_SECRET = `whsec_${"c".repeat(32)}`;
export const FLW_SECRET = `FLWSECK_TEST-${"d".repeat(32)}-X`;
export const FLW_HASH = "flutterwave-webhook-hash-0123456789";
export const THUNES_BASE = "https://api-mt.thunes.test";
export const THUNES_KEY = "thunes-key-01";
export const THUNES_SECRET = "thunes-secret-0123456789";

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

export class FakePaymentProviders {
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
  /**
   * Identifiants fournisseurs uniques entre fichiers de test (la base est
   * partagée et payments.attempts impose l'unicité fournisseur + référence) :
   * base en microsecondes, toujours en deçà de Number.MAX_SAFE_INTEGER.
   */
  private counter = Date.now() * 1000;

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

export function raw(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}
