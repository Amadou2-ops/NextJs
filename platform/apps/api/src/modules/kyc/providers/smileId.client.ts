import { createHmac } from "node:crypto";

import { z } from "zod";

import { constantTimeEqual, WebhookSignatureError } from "../../../lib/crypto/webhookSignature.js";
import { KycProviderError, parseIsoDate } from "./types.js";
import type {
  ExtractedIdentity,
  IdentityDocumentType,
  KycJobType,
  KycProvider,
  OutcomeRequest,
  OutcomeSummary,
  ProviderOutcome,
  ProviderSession,
  StartSessionInput,
} from "./types.js";

/**
 * Smile ID (API v1).
 *
 * Signature Smile ID : base64(HMAC-SHA256(clé API, horodatage ISO 8601 ‖
 * partner_id ‖ "sid_request")). Elle authentifie nos requêtes, les réponses
 * de job_status et les rappels (callbacks). Elle ne couvre PAS le contenu du
 * message : un rappel authentifié sert seulement de signal, le résultat est
 * toujours relu par POST /job_status (TLS) et sa signature de réponse
 * vérifiée.
 *
 * Mobile : le SDK soumet le job lui-même avec les paramètres signés fournis
 * par l'API (job_id = identifiant de notre vérification). Web : intégration
 * hébergée, jeton obtenu par POST /token.
 */

const REQUEST_TIMEOUT_MS = 15_000;

const SMILE_JOB_TYPES: Readonly<Partial<Record<KycJobType, { readonly jobType: number; readonly product: string }>>> = {
  biometric_kyc: { jobType: 1, product: "biometric_kyc" },
  document_verification: { jobType: 6, product: "doc_verification" },
};

const SMILE_DOCUMENT_TYPES: readonly (readonly [RegExp, IdentityDocumentType])[] = [
  [/^PASSPORT$/, "passport"],
  [/^(NATIONAL_ID|NATIONAL_ID_NO_PHOTO|NIN|NIN_V2|NIN_SLIP|ALIEN_CARD|GHANA_CARD|IDENTITY_CARD)$/, "national_id"],
  [/^(DRIVERS_LICENSE|DRIVING_LICENSE|DRIVERS_LICENCE)$/, "driving_licence"],
  [/^(RESIDENT_ID|RESIDENCE_PERMIT)$/, "residence_permit"],
];

const signedResponseSchema = z.object({
  timestamp: z.string().min(1),
  signature: z.string().min(1),
});

const jobStatusSchema = signedResponseSchema.extend({
  job_complete: z.boolean(),
  job_success: z.boolean(),
  code: z.string().optional(),
  result: z.unknown().optional(),
});

const partnerParamsSchema = z.object({
  job_id: z.string(),
  user_id: z.string(),
  job_type: z.union([z.string(), z.number()]).optional(),
});

const resultSchema = z.object({
  ResultCode: z.string().optional(),
  ResultText: z.string().optional(),
  SmileJobID: z.string().optional(),
  PartnerParams: partnerParamsSchema,
  Actions: z.record(z.string(), z.string()).optional(),
  FullName: z.string().optional(),
  DOB: z.string().optional(),
  IDNumber: z.string().optional(),
  IDType: z.string().optional(),
  Country: z.string().optional(),
});

/** Champs utilisés d'un rappel Smile ID (le reste est ignoré, jamais stocké). */
const callbackSchema = z.object({
  timestamp: z.string().min(1).max(64),
  signature: z.string().min(1).max(256),
  ResultCode: z.string().max(16).optional(),
  SmileJobID: z.string().max(64).optional(),
  PartnerParams: partnerParamsSchema,
});

export interface SmileIdClientOptions {
  readonly partnerId: string;
  readonly apiKey: string;
  readonly environment: "sandbox" | "production";
  readonly baseUrl: string;
  readonly callbackUrl: string;
}

export function smileSignature(apiKey: string, partnerId: string, isoTimestamp: string): string {
  return createHmac("sha256", apiKey).update(isoTimestamp, "utf8").update(partnerId, "utf8").update("sid_request", "utf8").digest("base64");
}

/** Vérifie une signature Smile ID (horodatage ISO 8601 strict, comparaison en temps constant). */
export function verifySmileSignature(apiKey: string, partnerId: string, timestamp: string, signature: string): boolean {
  if (Number.isNaN(Date.parse(timestamp)) || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const expected = Buffer.from(smileSignature(apiKey, partnerId, timestamp), "base64");
  return constantTimeEqual(expected, Buffer.from(signature, "base64"));
}

export interface VerifiedSmileCallback {
  readonly jobId: string;
  readonly userId: string;
  readonly resultCode: string | null;
  readonly smileJobId: string | null;
  readonly signedAt: Date;
}

/**
 * Authentifie un rappel Smile ID : signature valide et horodatage signé dans
 * la fenêtre de tolérance (anti-rejeu).
 */
export function verifySmileCallback(params: {
  readonly body: unknown;
  readonly partnerId: string;
  readonly apiKey: string;
  readonly toleranceSeconds: number;
  readonly nowMs?: number;
}): VerifiedSmileCallback {
  const parsed = callbackSchema.safeParse(params.body);
  if (!parsed.success) {
    const missing = typeof params.body !== "object" || params.body === null || !("signature" in params.body);
    throw new WebhookSignatureError(missing ? "missing_signature" : "malformed_payload", "rappel Smile ID illisible");
  }
  const callback = parsed.data;
  if (!verifySmileSignature(params.apiKey, params.partnerId, callback.timestamp, callback.signature)) {
    throw new WebhookSignatureError("invalid_signature", "signature Smile ID invalide");
  }
  const signedAt = new Date(callback.timestamp);
  const skewSeconds = Math.abs((params.nowMs ?? Date.now()) - signedAt.getTime()) / 1000;
  if (skewSeconds > params.toleranceSeconds) {
    throw new WebhookSignatureError("timestamp_out_of_tolerance", `horodatage hors tolérance (${Math.round(skewSeconds)} s)`);
  }
  return {
    jobId: callback.PartnerParams.job_id,
    userId: callback.PartnerParams.user_id,
    resultCode: callback.ResultCode ?? null,
    smileJobId: callback.SmileJobID ?? null,
    signedAt,
  };
}

export class SmileIdClient implements KycProvider {
  readonly name = "smile_id" as const;

  constructor(
    private readonly options: SmileIdClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(jobType: KycJobType): boolean {
    return SMILE_JOB_TYPES[jobType] !== undefined;
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const job = SMILE_JOB_TYPES[input.jobType];
    if (job === undefined) throw new KycProviderError(this.name, `type de contrôle non pris en charge : ${input.jobType}`, false);
    const signed = this.sign();
    let webToken: string | null = null;
    if (input.channel === "web") {
      const body = z
        .object({ token: z.string().min(1) })
        .safeParse(
          await this.post("/token", {
            partner_id: this.options.partnerId,
            user_id: input.userId,
            job_id: input.verificationId,
            product: job.product,
            callback_url: this.options.callbackUrl,
            ...signed,
          }),
        );
      if (!body.success) throw new KycProviderError(this.name, "jeton web absent de la réponse", false);
      webToken = body.data.token;
    }
    return {
      providerReference: input.verificationId,
      applicantReference: null,
      launch: {
        provider: "smile_id",
        partnerId: this.options.partnerId,
        environment: this.options.environment,
        jobId: input.verificationId,
        userId: input.userId,
        jobType: job.jobType,
        product: job.product,
        callbackUrl: this.options.callbackUrl,
        signature: signed.signature,
        timestamp: signed.timestamp,
        webToken,
      },
    };
  }

  async fetchOutcome(request: OutcomeRequest): Promise<ProviderOutcome> {
    const raw = await this.post("/job_status", {
      partner_id: this.options.partnerId,
      user_id: request.userId,
      job_id: request.providerReference,
      history: false,
      image_links: false,
      ...this.sign(),
    });
    const parsed = jobStatusSchema.safeParse(raw);
    if (!parsed.success) throw new KycProviderError(this.name, "réponse job_status illisible", false);
    const status = parsed.data;
    if (!verifySmileSignature(this.options.apiKey, this.options.partnerId, status.timestamp, status.signature)) {
      throw new KycProviderError(this.name, "signature de la réponse job_status invalide", false);
    }

    const result = resultSchema.safeParse(status.result);
    if (!result.success) {
      // Aucun résultat encore (job non soumis ou en file d'attente).
      if (status.job_complete) throw new KycProviderError(this.name, "job terminé sans résultat lisible", false);
      return { kind: "pending", summary: { providerStatus: "awaiting_result", resultCode: status.code ?? null, resultText: null, reasons: [] } };
    }
    const data = result.data;
    if (data.PartnerParams.job_id !== request.providerReference || data.PartnerParams.user_id !== request.userId) {
      throw new KycProviderError(this.name, "le résultat ne correspond pas au job demandé", false);
    }

    const reasons = Object.entries(data.Actions ?? {})
      .filter(([, value]) => /^(Failed|Not Verified|Rejected|Not Returned|Possible Spoof)/i.test(value))
      .map(([key, value]) => `${key}:${value}`)
      .slice(0, 20);
    const summary: OutcomeSummary = {
      providerStatus: status.job_complete ? (status.job_success ? "complete_success" : "complete_failure") : "under_review",
      resultCode: data.ResultCode ?? null,
      resultText: data.ResultText ?? null,
      reasons,
    };
    if (!status.job_complete) return { kind: "provider_review", summary };
    const identity = extractSmileIdentity(data);
    return status.job_success ? { kind: "approved", summary, identity } : { kind: "rejected", summary, identity };
  }

  private sign(): { readonly signature: string; readonly timestamp: string } {
    const timestamp = this.now().toISOString();
    return { signature: smileSignature(this.options.apiKey, this.options.partnerId, timestamp), timestamp };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new KycProviderError(this.name, "prestataire injoignable", true, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new KycProviderError(this.name, `${path} : HTTP ${response.status}`, response.status === 429 || response.status >= 500);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new KycProviderError(this.name, "réponse JSON invalide", true, { cause: error });
    }
  }
}

function extractSmileIdentity(result: z.infer<typeof resultSchema>): ExtractedIdentity | null {
  const fullName = result.FullName?.trim() ?? "";
  const dateOfBirth = result.DOB === undefined ? null : parseIsoDate(result.DOB);
  const documentNumber = result.IDNumber?.trim() ?? "";
  const idType = result.IDType?.trim().toUpperCase() ?? "";
  const documentType = SMILE_DOCUMENT_TYPES.find(([pattern]) => pattern.test(idType))?.[1] ?? null;
  const country = result.Country?.trim().toUpperCase() ?? "";
  if (fullName.length === 0 && dateOfBirth === null && documentNumber.length === 0) return null;
  return {
    documentType,
    issuingCountry: /^[A-Z]{2,3}$/.test(country) ? country : null,
    // Un numéro qui n'identifie pas une pièce (ex. BVN bancaire) n'alimente pas la détection de doublons de pièce.
    documentNumber: documentType === null || documentNumber.length === 0 ? null : documentNumber,
    fullName: fullName.length === 0 ? null : fullName,
    dateOfBirth,
  };
}
