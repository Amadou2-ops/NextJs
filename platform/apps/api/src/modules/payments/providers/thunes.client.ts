import { Buffer } from "node:buffer";

import { parseJsonPreservingNumbers } from "../../../lib/json.js";
import { decimalStringToMinor, decimalStringToMinorCeil, minorToDecimalString } from "../../../lib/money.js";
import { PaymentProviderError, providerFetch, statusOf } from "./types.js";
import type { PayoutMethod, PayoutProvider, PayoutRequest, ProviderStatus } from "./types.js";

/**
 * Thunes — Money Transfer API v2 (paiements sortants internationaux :
 * mobile money, comptes bancaires, retrait en espèces).
 *
 * Parcours d'un ordre (identifiants externes = clé d'idempotence) :
 *   1. POST /v2/money-transfer/quotations             (external_id « <clé>-q », mode DESTINATION_AMOUNT)
 *   2. POST /v2/money-transfer/quotations/ext-…/transactions (external_id « <clé> »)
 *   3. POST /v2/money-transfer/transactions/ext-…/confirm
 * État : GET /v2/money-transfer/transactions/ext-<clé> ; classes de statut
 * 1 créé, 2 confirmé, 3 rejeté, 4 annulé, 5 soumis, 6 disponible, 7 terminé,
 * 8 reversé, 9 refusé par le payeur.
 * Authentification HTTP Basic (clé API : secret).
 */

/** Motifs de transfert de la plateforme → énumération Thunes. */
export const THUNES_PURPOSES: Readonly<Record<string, string>> = {
  family_support: "FAMILY_SUPPORT",
  education: "EDUCATION",
  medical_treatment: "MEDICAL_TREATMENT",
  gift: "GIFT_AND_DONATION",
  household_expenses: "MAINTENANCE_EXPENSES",
  savings: "PERSONAL_TRANSFER",
  travel: "TRAVEL",
  other: "OTHER",
};

type ThunesObject = Readonly<Record<string, unknown>>;

function text(object: ThunesObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nested(object: ThunesObject, key: string): ThunesObject | null {
  const value = object[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ThunesObject) : null;
}

export interface ThunesClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly callbackUrl: string;
  readonly settlementCurrency: string;
}

export class ThunesClient implements PayoutProvider {
  readonly name = "thunes" as const;
  private readonly authorization: string;

  constructor(
    private readonly options: ThunesClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`, "utf8").toString("base64")}`;
  }

  supports(method: PayoutMethod): boolean {
    return method === "mobile_money" || method === "bank_account" || method === "cash_pickup";
  }

  async createPayout(request: PayoutRequest): Promise<ProviderStatus> {
    if (request.routeCode === null) throw new PaymentProviderError(this.name, "payeur Thunes absent du corridor", false, false, "route_code_missing");
    const purpose = THUNES_PURPOSES[request.purposeCode];
    if (purpose === undefined) throw new PaymentProviderError(this.name, `motif non pris en charge : ${request.purposeCode}`, false, false, "unsupported_purpose");
    const quotationId = `${request.idempotencyKey}-q`;

    await this.call("POST", "/v2/money-transfer/quotations", 201, {
      external_id: quotationId,
      payer_id: request.routeCode,
      mode: "DESTINATION_AMOUNT",
      transaction_type: "C2C",
      source: { amount: "", currency: this.options.settlementCurrency, country_iso_code: request.sourceCountryAlpha3 },
      destination: { amount: minorToDecimalString(request.amountMinor, request.minorUnits), currency: request.currency },
    });

    const account = request.recipient.account;
    const creditParty: Record<string, string> =
      account.kind === "bank_account"
        ? account.iban !== null
          ? { iban: account.iban }
          : { bank_account_number: account.accountNumber ?? "", ...(account.bankCode === null ? {} : { swift_bic_code: account.bankCode }) }
        : { msisdn: account.msisdn };
    const sender: Record<string, string> = {
      firstname: request.sender.firstName,
      lastname: request.sender.lastName,
      country_iso_code: request.sender.countryAlpha3,
    };
    if (request.sender.dateOfBirth !== null) sender["date_of_birth"] = request.sender.dateOfBirth;
    if (request.sender.nationalityAlpha3 !== null) sender["nationality_country_iso_code"] = request.sender.nationalityAlpha3;

    await this.call("POST", `/v2/money-transfer/quotations/ext-${encodeURIComponent(quotationId)}/transactions`, 201, {
      external_id: request.idempotencyKey,
      credit_party_identifier: creditParty,
      beneficiary: { firstname: request.recipient.firstName, lastname: request.recipient.lastName },
      sender,
      purpose_of_remittance: purpose,
      callback_url: this.options.callbackUrl,
    });

    const confirmed = await this.call("POST", `/v2/money-transfer/transactions/ext-${encodeURIComponent(request.idempotencyKey)}/confirm`, 200, {});
    return this.transactionStatus(confirmed, request.minorUnits);
  }

  async getPayout(attempt: { readonly idempotencyKey: string; readonly minorUnits: number }): Promise<ProviderStatus> {
    let transaction: ThunesObject;
    try {
      transaction = await this.call("GET", `/v2/money-transfer/transactions/ext-${encodeURIComponent(attempt.idempotencyKey)}`, 200, null);
    } catch (error: unknown) {
      if (error instanceof PaymentProviderError && error.providerCode === "not_found") {
        // Aucune transaction créée chez Thunes pour cette clé : rien n'a été exécuté.
        return statusOf("failed", { failureCode: "not_created", failureMessage: "transaction absente chez Thunes", summary: { stage: "not_created" } });
      }
      throw error;
    }
    if (text(transaction, "status_class") === "1") {
      // Créée mais non confirmée (interruption entre les étapes) : confirmation.
      transaction = await this.call("POST", `/v2/money-transfer/transactions/ext-${encodeURIComponent(attempt.idempotencyKey)}/confirm`, 200, {});
    }
    return this.transactionStatus(transaction, attempt.minorUnits);
  }

  private transactionStatus(transaction: ThunesObject, minorUnits: number): ProviderStatus {
    const id = text(transaction, "id");
    const statusClass = text(transaction, "status_class") ?? "0";
    const destination = nested(transaction, "destination");
    const destinationAmount = destination === null ? null : text(destination, "amount");
    const destinationCurrency = destination === null ? null : text(destination, "currency");
    const amount =
      destinationAmount === null || destinationCurrency === null
        ? null
        : { amountMinor: decimalStringToMinor(destinationAmount, minorUnits), currency: destinationCurrency };
    const feeObject = nested(transaction, "fee");
    const feeAmount = feeObject === null ? null : text(feeObject, "amount");
    const feeCurrency = feeObject === null ? null : text(feeObject, "currency");
    const fee =
      feeAmount === null || feeCurrency === null || feeCurrency !== destinationCurrency
        ? null
        : { amountMinor: decimalStringToMinorCeil(feeAmount, minorUnits), currency: feeCurrency };
    const summary = {
      transaction_id: id,
      status: text(transaction, "status"),
      status_class: statusClass,
      status_message: (text(transaction, "status_message") ?? "").slice(0, 120),
    };
    switch (statusClass) {
      case "1":
        return statusOf("pending", { providerReference: id, amount, summary });
      case "2":
      case "5":
      case "6":
        return statusOf("processing", { providerReference: id, amount, summary });
      case "7":
        return statusOf("succeeded", { providerReference: id, amount, fee: fee?.amountMinor === 0n ? null : fee, summary });
      case "3":
      case "4":
      case "9":
        return statusOf("failed", {
          providerReference: id,
          amount,
          failureCode: `thunes_${(text(transaction, "status_class_message") ?? statusClass).toLowerCase()}`,
          failureMessage: summary.status_message,
          summary,
        });
      case "8":
        return statusOf("reversed", { providerReference: id, amount, failureCode: "thunes_reversed", summary });
      default:
        throw new PaymentProviderError(this.name, `classe de statut inconnue : ${statusClass}`, false, false);
    }
  }

  private async call(method: "GET" | "POST", path: string, expectedStatus: number, body: unknown): Promise<ThunesObject> {
    const response = await providerFetch(this.name, this.fetchImpl, `${this.options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      mutating: method === "POST",
    });
    let parsed: unknown;
    try {
      parsed = response.text.length === 0 ? {} : parseJsonPreservingNumbers(response.text);
    } catch (error: unknown) {
      throw new PaymentProviderError(this.name, "réponse JSON invalide", true, method === "POST", null, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new PaymentProviderError(this.name, "réponse inattendue", false, false);
    if (response.status !== expectedStatus) {
      const errors = (parsed as ThunesObject)["errors"];
      const first = Array.isArray(errors) && typeof errors[0] === "object" && errors[0] !== null ? (errors[0] as ThunesObject) : null;
      const code = first === null ? null : text(first, "code");
      throw new PaymentProviderError(
        this.name,
        `HTTP ${response.status.toString()} ${code ?? ""} ${(first === null ? "" : (text(first, "message") ?? "")).slice(0, 160)}`.trim(),
        false,
        false,
        response.status === 404 ? "not_found" : code,
      );
    }
    return parsed as ThunesObject;
  }
}
