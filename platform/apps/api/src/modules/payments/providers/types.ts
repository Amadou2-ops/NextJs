/**
 * Contrat commun des prestataires de paiement.
 *
 * Règles :
 *   - tout montant est en unités mineures (bigint) côté plateforme ; la
 *     conversion vers le format du prestataire est exacte et réversible ;
 *   - chaque ordre porte une clé d'idempotence stable (en-tête
 *     Idempotency-Key Stripe, tx_ref / reference Flutterwave, external_id
 *     Thunes) : un ordre rejoué n'est jamais exécuté deux fois ;
 *   - un statut lu chez le prestataire est toujours accompagné du montant et
 *     de la devise constatés, que l'appelant compare à l'ordre d'origine.
 */

export type PaymentProviderName = "stripe" | "flutterwave" | "thunes";
export type FundingMethod = "wallet_balance" | "card" | "bank_transfer" | "mobile_money" | "apple_pay" | "google_pay";
export type PayoutMethod = "bank_account" | "mobile_money" | "cash_pickup" | "card" | "wallet";

export type AttemptStatus = "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled" | "reversed";

export interface ProviderAmount {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** État constaté chez le prestataire. */
export interface ProviderStatus {
  readonly status: Exclude<AttemptStatus, "pending" | "reversed"> | "pending" | "reversed";
  readonly providerReference: string | null;
  /** Montant et devise constatés (null si le prestataire ne les renvoie pas à ce stade). */
  readonly amount: ProviderAmount | null;
  /** Frais prélevés par le prestataire, s'ils sont connus. */
  readonly fee: ProviderAmount | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** Résumé non nominatif conservé avec la tentative. */
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PayinCustomer {
  readonly email: string | null;
  readonly phoneE164: string;
  readonly fullName: string;
}

export interface PayinRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly transferId: string;
  readonly transferReference: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly minorUnits: number;
  readonly fundingMethod: Exclude<FundingMethod, "wallet_balance">;
  readonly customer: PayinCustomer;
}

/** Action attendue du client pour payer. */
export type FundingAction =
  | { readonly type: "stripe_payment_intent"; readonly clientSecret: string; readonly publishableKey: string }
  | { readonly type: "redirect"; readonly url: string };

export interface PayinSession {
  readonly providerReference: string;
  readonly action: FundingAction;
  readonly status: ProviderStatus;
  /** Données non secrètes à conserver pour reprendre le paiement (ex. lien hébergé). */
  readonly resumable: Readonly<Record<string, string>>;
}

export interface PayinProvider {
  readonly name: PaymentProviderName;
  createPayin(request: PayinRequest): Promise<PayinSession>;
  getPayin(attempt: { readonly providerReference: string | null; readonly idempotencyKey: string; readonly minorUnits: number }): Promise<ProviderStatus>;
  /** Action de paiement à jour (le secret client n'est jamais stocké). */
  resumePayin(attempt: { readonly providerReference: string; readonly resumable: Readonly<Record<string, unknown>> }): Promise<FundingAction>;
  cancelPayin(attempt: { readonly providerReference: string | null; readonly idempotencyKey: string }): Promise<void>;
  createRefund(request: {
    readonly idempotencyKey: string;
    /** Encaissement à rembourser : référence et résumé conservés lors de son succès. */
    readonly payin: { readonly providerReference: string; readonly summary: Readonly<Record<string, unknown>> };
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly minorUnits: number;
  }): Promise<ProviderStatus>;
  getRefund(attempt: { readonly providerReference: string; readonly minorUnits: number }): Promise<ProviderStatus>;
}

export interface PayoutParty {
  readonly firstName: string;
  readonly lastName: string;
}

export type RecipientAccount =
  | { readonly kind: "mobile_money"; readonly msisdn: string; readonly operator: string }
  | { readonly kind: "bank_account"; readonly iban: string | null; readonly accountNumber: string | null; readonly bankCode: string | null }
  | { readonly kind: "cash_pickup"; readonly msisdn: string };

export interface PayoutRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly transferReference: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly minorUnits: number;
  readonly sourceCountryAlpha3: string;
  readonly destinationCountry: string;
  readonly destinationCountryAlpha3: string;
  readonly payoutMethod: PayoutMethod;
  readonly routeCode: string | null;
  readonly purposeCode: string;
  readonly recipient: PayoutParty & { readonly account: RecipientAccount };
  readonly sender: PayoutParty & { readonly dateOfBirth: string | null; readonly countryAlpha3: string; readonly nationalityAlpha3: string | null };
}

export interface PayoutProvider {
  readonly name: PaymentProviderName;
  supports(method: PayoutMethod): boolean;
  createPayout(request: PayoutRequest): Promise<ProviderStatus>;
  getPayout(attempt: { readonly providerReference: string | null; readonly idempotencyKey: string; readonly minorUnits: number }): Promise<ProviderStatus>;
}

/**
 * Erreur prestataire.
 *   - retryable : panne transitoire (réseau, 5xx, 429) ; l'ordre peut être
 *     rejoué avec la même clé d'idempotence ;
 *   - outcomeUnknown : la requête a pu être exécutée sans que la réponse
 *     soit reçue ; aucune nouvelle route ne doit être tentée avant
 *     réconciliation (risque de double paiement).
 */
export class PaymentProviderError extends Error {
  override readonly name = "PaymentProviderError";
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
    readonly retryable: boolean,
    readonly outcomeUnknown: boolean,
    readonly providerCode: string | null = null,
    options?: { readonly cause?: unknown },
  ) {
    super(`${provider} : ${message}`, options);
  }
}

export function statusOf(
  status: ProviderStatus["status"],
  fields: Partial<Omit<ProviderStatus, "status">> = {},
): ProviderStatus {
  return {
    status,
    providerReference: fields.providerReference ?? null,
    amount: fields.amount ?? null,
    fee: fields.fee ?? null,
    failureCode: fields.failureCode ?? null,
    failureMessage: fields.failureMessage ?? null,
    summary: fields.summary ?? {},
  };
}

/** Requête HTTP vers un prestataire avec délai, sans redirection, et classification des erreurs. */
export async function providerFetch(
  provider: PaymentProviderName,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { readonly mutating: boolean },
  timeoutMs = 20_000,
): Promise<{ readonly status: number; readonly text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error: unknown) {
    // Une requête mutatrice interrompue a pu être exécutée par le prestataire.
    throw new PaymentProviderError(provider, "prestataire injoignable ou délai dépassé", true, init.mutating, null, { cause: error });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error: unknown) {
    throw new PaymentProviderError(provider, "réponse interrompue", true, init.mutating, null, { cause: error });
  }
  if (response.status >= 500 || response.status === 429) {
    throw new PaymentProviderError(provider, `HTTP ${response.status.toString()}`, true, init.mutating && response.status >= 500);
  }
  return { status: response.status, text };
}
