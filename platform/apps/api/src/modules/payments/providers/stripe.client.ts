import { parseJsonPreservingNumbers } from "../../../lib/json.js";
import { PaymentProviderError, providerFetch, statusOf } from "./types.js";
import type { FundingAction, PayinProvider, PayinRequest, PayinSession, ProviderStatus } from "./types.js";

/**
 * Stripe — encaissement par carte (et portefeuilles Apple Pay / Google Pay,
 * qui sont des cartes tokenisées) via PaymentIntents.
 *
 * API v1 : corps application/x-www-form-urlencoded, authentification
 * « Authorization: Bearer <clé secrète> », version d'API épinglée par
 * l'en-tête Stripe-Version, idempotence par l'en-tête Idempotency-Key.
 * Le secret client du PaymentIntent n'est jamais stocké : il est relu à la
 * demande pour reprendre un paiement.
 */

const BASE_URL = "https://api.stripe.com/v1";

type FormValue = string | bigint | number | boolean;
type FormFields = Readonly<Record<string, FormValue | Readonly<Record<string, FormValue>> | readonly FormValue[]>>;

/** Encodage « form » de Stripe : objets en a[b]=c, tableaux en a[0]=c. */
export function encodeStripeForm(fields: FormFields): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      (value as readonly FormValue[]).forEach((item, index) => {
        params.append(`${key}[${index.toString()}]`, String(item));
      });
    } else if (typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value as Readonly<Record<string, FormValue>>)) {
        params.append(`${key}[${subKey}]`, String(subValue));
      }
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

type StripeObject = Readonly<Record<string, unknown>>;

function field(object: StripeObject, key: string): unknown {
  return object[key];
}

function text(object: StripeObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(object: StripeObject, key: string): bigint | null {
  const value = object[key];
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? BigInt(value) : null;
}

export interface StripeClientOptions {
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly apiVersion: string;
}

export class StripeClient implements PayinProvider {
  readonly name = "stripe" as const;

  constructor(
    private readonly options: StripeClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createPayin(request: PayinRequest): Promise<PayinSession> {
    const intent = await this.call("POST", "/payment_intents", request.idempotencyKey, {
      amount: request.amountMinor,
      currency: request.currency.toLowerCase(),
      capture_method: "automatic",
      // Apple Pay et Google Pay sont présentés par le Payment Element comme des cartes.
      payment_method_types: ["card"],
      description: `Transfert ${request.transferReference}`,
      metadata: { transfer_id: request.transferId, transfer_reference: request.transferReference, attempt_id: request.attemptId },
    });
    const id = text(intent, "id");
    const clientSecret = text(intent, "client_secret");
    if (id === null || clientSecret === null) throw new PaymentProviderError(this.name, "PaymentIntent incomplet", false, false);
    return {
      providerReference: id,
      action: { type: "stripe_payment_intent", clientSecret, publishableKey: this.options.publishableKey },
      status: this.intentStatus(intent),
      resumable: {},
    };
  }

  async getPayin(attempt: { readonly providerReference: string | null; readonly idempotencyKey: string }): Promise<ProviderStatus> {
    if (attempt.providerReference === null) {
      throw new PaymentProviderError(this.name, "PaymentIntent inconnu (création non confirmée)", false, true);
    }
    const intent = await this.call("GET", `/payment_intents/${encodeURIComponent(attempt.providerReference)}?expand[]=latest_charge.balance_transaction`, null, null);
    return this.intentStatus(intent);
  }

  async resumePayin(attempt: { readonly providerReference: string }): Promise<FundingAction> {
    const intent = await this.call("GET", `/payment_intents/${encodeURIComponent(attempt.providerReference)}`, null, null);
    const clientSecret = text(intent, "client_secret");
    if (clientSecret === null) throw new PaymentProviderError(this.name, "secret client absent", false, false);
    return { type: "stripe_payment_intent", clientSecret, publishableKey: this.options.publishableKey };
  }

  async cancelPayin(attempt: { readonly providerReference: string | null; readonly idempotencyKey: string }): Promise<void> {
    if (attempt.providerReference === null) return;
    await this.call("POST", `/payment_intents/${encodeURIComponent(attempt.providerReference)}/cancel`, `${attempt.idempotencyKey}-cancel`, {
      cancellation_reason: "abandoned",
    });
  }

  async createRefund(request: {
    readonly idempotencyKey: string;
    readonly payin: { readonly providerReference: string };
    readonly amountMinor: bigint;
  }): Promise<ProviderStatus> {
    const refund = await this.call("POST", "/refunds", request.idempotencyKey, {
      payment_intent: request.payin.providerReference,
      amount: request.amountMinor,
      reason: "requested_by_customer",
    });
    return this.refundStatus(refund);
  }

  async getRefund(attempt: { readonly providerReference: string }): Promise<ProviderStatus> {
    return this.refundStatus(await this.call("GET", `/refunds/${encodeURIComponent(attempt.providerReference)}`, null, null));
  }

  private intentStatus(intent: StripeObject): ProviderStatus {
    const id = text(intent, "id");
    const currency = text(intent, "currency")?.toUpperCase() ?? null;
    const status = text(intent, "status") ?? "unknown";
    const received = integer(intent, "amount_received");
    const lastError = field(intent, "last_payment_error") as StripeObject | null | undefined;
    const summary = {
      payment_intent_status: status,
      last_error_code: lastError === null || lastError === undefined ? null : text(lastError, "code"),
      decline_code: lastError === null || lastError === undefined ? null : text(lastError, "decline_code"),
    };
    const fee = this.chargeFee(intent);
    switch (status) {
      case "succeeded":
        return statusOf("succeeded", {
          providerReference: id,
          amount: received === null || currency === null ? null : { amountMinor: received, currency },
          fee,
          summary,
        });
      case "processing":
      case "requires_capture":
        return statusOf("processing", { providerReference: id, summary });
      case "requires_payment_method":
      case "requires_confirmation":
      case "requires_action":
        return statusOf("requires_action", { providerReference: id, summary });
      case "canceled":
        return statusOf("cancelled", { providerReference: id, failureCode: text(intent, "cancellation_reason") ?? "canceled", summary });
      default:
        throw new PaymentProviderError(this.name, `statut de PaymentIntent inconnu : ${status}`, false, false);
    }
  }

  private chargeFee(intent: StripeObject): { amountMinor: bigint; currency: string } | null {
    const charge = field(intent, "latest_charge");
    if (typeof charge !== "object" || charge === null) return null;
    const balance = field(charge as StripeObject, "balance_transaction");
    if (typeof balance !== "object" || balance === null) return null;
    const fee = integer(balance as StripeObject, "fee");
    const currency = text(balance as StripeObject, "currency");
    return fee === null || currency === null || fee === 0n ? null : { amountMinor: fee, currency: currency.toUpperCase() };
  }

  private refundStatus(refund: StripeObject): ProviderStatus {
    const id = text(refund, "id");
    const amount = integer(refund, "amount");
    const currency = text(refund, "currency")?.toUpperCase() ?? null;
    const status = text(refund, "status") ?? "unknown";
    const measured = amount === null || currency === null ? null : { amountMinor: amount, currency };
    const summary = { refund_status: status };
    switch (status) {
      case "succeeded":
        return statusOf("succeeded", { providerReference: id, amount: measured, summary });
      case "pending":
      case "requires_action":
        return statusOf("processing", { providerReference: id, amount: measured, summary });
      case "failed":
        return statusOf("failed", { providerReference: id, amount: measured, failureCode: text(refund, "failure_reason") ?? "refund_failed", summary });
      case "canceled":
        return statusOf("cancelled", { providerReference: id, amount: measured, failureCode: "refund_canceled", summary });
      default:
        throw new PaymentProviderError(this.name, `statut de remboursement inconnu : ${status}`, false, false);
    }
  }

  private async call(method: "GET" | "POST", path: string, idempotencyKey: string | null, fields: FormFields | null): Promise<StripeObject> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.secretKey}`,
      "Stripe-Version": this.options.apiVersion,
      Accept: "application/json",
    };
    if (idempotencyKey !== null) headers["Idempotency-Key"] = idempotencyKey;
    if (fields !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await providerFetch(this.name, this.fetchImpl, `${BASE_URL}${path}`, {
      method,
      headers,
      ...(fields === null ? {} : { body: encodeStripeForm(fields) }),
      mutating: method === "POST",
    });
    let body: unknown;
    try {
      body = parseJsonPreservingNumbers(response.text);
    } catch (error: unknown) {
      throw new PaymentProviderError(this.name, "réponse JSON invalide", true, method === "POST", null, { cause: error });
    }
    if (typeof body !== "object" || body === null) throw new PaymentProviderError(this.name, "réponse inattendue", false, false);
    if (response.status >= 400) {
      const error = field(body as StripeObject, "error");
      const code = typeof error === "object" && error !== null ? (text(error as StripeObject, "code") ?? text(error as StripeObject, "type")) : null;
      throw new PaymentProviderError(this.name, `HTTP ${response.status.toString()} (${code ?? "erreur"})`, false, false, code);
    }
    return body as StripeObject;
  }
}
