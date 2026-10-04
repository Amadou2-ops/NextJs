import { DecimalLiteral, parseJsonPreservingNumbers, stringifyWithDecimals } from "../../../lib/json.js";
import { decimalStringToMinor, decimalStringToMinorCeil, minorToDecimalString } from "../../../lib/money.js";
import { PaymentProviderError, providerFetch, statusOf } from "./types.js";
import type {
  FundingAction,
  PayinProvider,
  PayinRequest,
  PayinSession,
  PayoutMethod,
  PayoutProvider,
  PayoutRequest,
  ProviderAmount,
  ProviderStatus,
} from "./types.js";

/**
 * Flutterwave (API v3) — encaissement mobile money / virement par page
 * hébergée (Flutterwave Standard) et paiements sortants (transfers) vers
 * comptes bancaires et portefeuilles mobile money africains.
 *
 * Authentification « Authorization: Bearer <clé secrète> ». Les montants sont
 * en unités principales : ils sont émis et relus comme décimaux exacts.
 * Unicité : tx_ref (encaissement) et reference (paiement sortant) portent la
 * clé d'idempotence de la tentative ; Flutterwave refuse une référence déjà
 * utilisée, ce qui interdit toute double exécution.
 */

const BASE_URL = "https://api.flutterwave.com/v3";

const PAYMENT_OPTIONS: Readonly<Record<PayinRequest["fundingMethod"], string>> = {
  mobile_money: "mobilemoneyfranco,mobilemoneyghana,mobilemoneyuganda,mobilemoneyrwanda,mobilemoneyzambia,mpesa",
  bank_transfer: "banktransfer,account",
  card: "card",
  apple_pay: "applepay",
  google_pay: "googlepay",
};

type FlwObject = Readonly<Record<string, unknown>>;

function text(object: FlwObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface FlutterwaveClientOptions {
  readonly secretKey: string;
  readonly redirectUrl: string;
}

export class FlutterwaveClient implements PayinProvider, PayoutProvider {
  readonly name = "flutterwave" as const;

  constructor(
    private readonly options: FlutterwaveClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(method: PayoutMethod): boolean {
    return method === "mobile_money" || method === "bank_account";
  }

  // ---------------------------------------------------------------------------
  // Encaissement
  // ---------------------------------------------------------------------------

  async createPayin(request: PayinRequest): Promise<PayinSession> {
    if (request.customer.email === null) {
      throw new PaymentProviderError(this.name, "adresse e-mail du payeur requise par la page de paiement", false, false, "email_required");
    }
    const data = await this.call("POST", "/payments", {
      tx_ref: request.idempotencyKey,
      amount: new DecimalLiteral(minorToDecimalString(request.amountMinor, request.minorUnits)),
      currency: request.currency,
      redirect_url: this.options.redirectUrl,
      payment_options: PAYMENT_OPTIONS[request.fundingMethod],
      customer: { email: request.customer.email, phonenumber: request.customer.phoneE164, name: request.customer.fullName },
      customizations: { title: "TransfertPlus", description: `Transfert ${request.transferReference}` },
      meta: { transfer_id: request.transferId, attempt_id: request.attemptId },
    });
    const link = text(data, "link");
    if (!link?.startsWith("https://")) throw new PaymentProviderError(this.name, "lien de paiement absent", false, false);
    return {
      providerReference: request.idempotencyKey,
      action: { type: "redirect", url: link },
      status: statusOf("requires_action", { providerReference: request.idempotencyKey, summary: { stage: "checkout_created" } }),
      resumable: { link },
    };
  }

  async getPayin(attempt: { readonly idempotencyKey: string; readonly minorUnits: number }): Promise<ProviderStatus> {
    let data: FlwObject;
    try {
      data = await this.call("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(attempt.idempotencyKey)}`, null);
    } catch (error: unknown) {
      // Aucune transaction pour cette référence : le client n'a pas encore payé.
      if (error instanceof PaymentProviderError && error.providerCode === "not_found") {
        return statusOf("requires_action", { providerReference: attempt.idempotencyKey, summary: { stage: "awaiting_payment" } });
      }
      throw error;
    }
    const status = text(data, "status") ?? "unknown";
    const transactionId = text(data, "id");
    const currency = text(data, "currency");
    const amount = this.amount(data, "amount", currency, attempt.minorUnits);
    const fee = currency === null || text(data, "app_fee") === null ? null : { amountMinor: decimalStringToMinorCeil(text(data, "app_fee") ?? "0", attempt.minorUnits), currency };
    const summary = { transaction_id: transactionId, flw_status: status, payment_type: text(data, "payment_type") };
    switch (status) {
      case "successful":
        return statusOf("succeeded", { providerReference: attempt.idempotencyKey, amount, fee: fee?.amountMinor === 0n ? null : fee, summary });
      case "pending":
        return statusOf("processing", { providerReference: attempt.idempotencyKey, amount, summary });
      case "failed":
        return statusOf("failed", {
          providerReference: attempt.idempotencyKey,
          amount,
          failureCode: "payment_failed",
          failureMessage: (text(data, "processor_response") ?? "").slice(0, 200),
          summary,
        });
      default:
        throw new PaymentProviderError(this.name, `statut de transaction inconnu : ${status}`, false, false);
    }
  }

  resumePayin(attempt: { readonly resumable: Readonly<Record<string, unknown>> }): Promise<FundingAction> {
    const link = attempt.resumable["link"];
    if (typeof link !== "string" || !link.startsWith("https://")) {
      return Promise.reject(new PaymentProviderError(this.name, "lien de paiement non conservé", false, false));
    }
    return Promise.resolve({ type: "redirect", url: link });
  }

  /**
   * Une page de paiement Flutterwave ne s'annule pas : l'appelant vérifie
   * d'abord qu'aucun paiement n'a abouti, et tout paiement tardif sur un
   * transfert annulé est isolé en compte d'attente et signalé.
   */
  async cancelPayin(): Promise<void> {
    await Promise.resolve();
  }

  async createRefund(request: {
    readonly idempotencyKey: string;
    readonly payin: { readonly providerReference: string; readonly summary: Readonly<Record<string, unknown>> };
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly minorUnits: number;
  }): Promise<ProviderStatus> {
    const transactionId = request.payin.summary["transaction_id"];
    if (typeof transactionId !== "string" || !/^\d{1,20}$/.test(transactionId)) {
      throw new PaymentProviderError(this.name, "identifiant de transaction à rembourser inconnu", false, false);
    }
    const data = await this.call("POST", `/transactions/${transactionId}/refund`, {
      amount: new DecimalLiteral(minorToDecimalString(request.amountMinor, request.minorUnits)),
    });
    return this.refundStatus(data, request.currency, request.minorUnits);
  }

  async getRefund(attempt: { readonly providerReference: string; readonly minorUnits: number }): Promise<ProviderStatus> {
    const data = await this.call("GET", `/refunds/${encodeURIComponent(attempt.providerReference)}`, null);
    return this.refundStatus(data, null, attempt.minorUnits);
  }

  // ---------------------------------------------------------------------------
  // Paiement sortant
  // ---------------------------------------------------------------------------

  async createPayout(request: PayoutRequest): Promise<ProviderStatus> {
    const account = request.recipient.account;
    let accountBank: string;
    let accountNumber: string;
    switch (account.kind) {
      case "mobile_money":
        if (request.routeCode === null) throw new PaymentProviderError(this.name, "code d'opérateur mobile money absent du corridor", false, false, "route_code_missing");
        accountBank = request.routeCode;
        accountNumber = account.msisdn.replace(/^\+/, "");
        break;
      case "bank_account":
        if (account.accountNumber === null || account.bankCode === null) {
          throw new PaymentProviderError(this.name, "numéro de compte et code banque requis", false, false, "unsupported_account");
        }
        accountBank = account.bankCode;
        accountNumber = account.accountNumber;
        break;
      case "cash_pickup":
        throw new PaymentProviderError(this.name, "retrait en espèces non pris en charge", false, false, "unsupported_method");
    }
    const data = await this.call("POST", "/transfers", {
      account_bank: accountBank,
      account_number: accountNumber,
      amount: new DecimalLiteral(minorToDecimalString(request.amountMinor, request.minorUnits)),
      currency: request.currency,
      debit_currency: request.currency,
      narration: `TransfertPlus ${request.transferReference}`,
      reference: request.idempotencyKey,
      beneficiary_name: `${request.recipient.firstName} ${request.recipient.lastName}`.slice(0, 100),
      meta: { sender: `${request.sender.firstName} ${request.sender.lastName}`.slice(0, 100), sender_country: request.sender.countryAlpha3 },
    });
    return this.transferStatus(data, request.minorUnits);
  }

  async getPayout(attempt: { readonly providerReference: string | null; readonly minorUnits: number }): Promise<ProviderStatus> {
    if (attempt.providerReference === null) {
      // Ordre émis sans réponse : seule une réconciliation manuelle (tableau
      // de bord Flutterwave, recherche par référence) peut trancher.
      throw new PaymentProviderError(this.name, "paiement sortant sans identifiant Flutterwave", false, true);
    }
    const data = await this.call("GET", `/transfers/${encodeURIComponent(attempt.providerReference)}`, null);
    return this.transferStatus(data, attempt.minorUnits);
  }

  private transferStatus(data: FlwObject, minorUnits: number): ProviderStatus {
    const id = text(data, "id");
    const status = (text(data, "status") ?? "unknown").toUpperCase();
    const currency = text(data, "currency");
    const amount = this.amount(data, "amount", currency, minorUnits);
    const feeText = text(data, "fee");
    const fee = feeText === null || currency === null ? null : { amountMinor: decimalStringToMinorCeil(feeText, minorUnits), currency };
    const summary = { transfer_id: id, flw_status: status };
    switch (status) {
      case "NEW":
      case "PENDING":
        return statusOf("processing", { providerReference: id, amount, summary });
      case "SUCCESSFUL":
        return statusOf("succeeded", { providerReference: id, amount, fee: fee?.amountMinor === 0n ? null : fee, summary });
      case "FAILED":
        return statusOf("failed", {
          providerReference: id,
          amount,
          failureCode: "transfer_failed",
          failureMessage: (text(data, "complete_message") ?? "").slice(0, 200),
          summary,
        });
      default:
        throw new PaymentProviderError(this.name, `statut de paiement sortant inconnu : ${status}`, false, false);
    }
  }

  private refundStatus(data: FlwObject, currency: string | null, minorUnits: number): ProviderStatus {
    const id = text(data, "id");
    const status = (text(data, "status") ?? "unknown").toLowerCase();
    const refunded = text(data, "amount_refunded");
    const amount = refunded === null || currency === null ? null : { amountMinor: decimalStringToMinor(refunded, minorUnits), currency };
    const summary = { refund_id: id, flw_status: status };
    switch (status) {
      case "completed":
      case "successful":
        return statusOf("succeeded", { providerReference: id, amount, summary });
      case "pending":
      case "pending-review":
        return statusOf("processing", { providerReference: id, amount, summary });
      case "failed":
        return statusOf("failed", { providerReference: id, amount, failureCode: "refund_failed", summary });
      default:
        throw new PaymentProviderError(this.name, `statut de remboursement inconnu : ${status}`, false, false);
    }
  }

  private amount(data: FlwObject, key: string, currency: string | null, minorUnits: number): ProviderAmount | null {
    const value = text(data, key);
    if (value === null || currency === null) return null;
    return { amountMinor: decimalStringToMinor(value, minorUnits), currency };
  }

  private async call(method: "GET" | "POST", path: string, body: unknown): Promise<FlwObject> {
    const response = await providerFetch(this.name, this.fetchImpl, `${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`,
        Accept: "application/json",
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === null ? {} : { body: stringifyWithDecimals(body) }),
      mutating: method === "POST",
    });
    let parsed: unknown;
    try {
      parsed = parseJsonPreservingNumbers(response.text);
    } catch (error: unknown) {
      throw new PaymentProviderError(this.name, "réponse JSON invalide", true, method === "POST", null, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null) throw new PaymentProviderError(this.name, "réponse inattendue", false, false);
    const envelope = parsed as FlwObject;
    const message = (text(envelope, "message") ?? "").slice(0, 200);
    if (response.status >= 400 || text(envelope, "status") !== "success") {
      const notFound = response.status === 404 || /no transaction was found/i.test(message);
      throw new PaymentProviderError(this.name, `HTTP ${response.status.toString()} : ${message}`, false, false, notFound ? "not_found" : "rejected");
    }
    const data = envelope["data"];
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new PaymentProviderError(this.name, "données absentes de la réponse", false, false);
    return data as FlwObject;
  }
}
