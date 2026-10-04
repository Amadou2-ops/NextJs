import { z } from "zod";

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
 * Onfido (API v3.6, Onfido Studio).
 *
 * Parcours : un dossier client (applicant) par utilisateur, puis un
 * « workflow run » par vérification. La création du run renvoie le jeton du
 * SDK de capture (mobile et web). Le résultat est lu sur le run
 * (GET /workflow_runs/{id}) : statut approved / declined / review /
 * abandoned / error, motifs, et sortie (output) du workflow.
 *
 * Sortie attendue du workflow (configurée dans Onfido Studio, « Workflow
 * output ») pour la lecture de l'identité : first_name, last_name,
 * date_of_birth, document_type, issuing_country, document_number (ou
 * document_numbers[{ type, value }]). En l'absence de ces données, la
 * vérification ne peut pas être approuvée automatiquement : elle part en
 * revue manuelle.
 *
 * Authentification : en-tête « Authorization: Token token=<jeton> ».
 */

const REQUEST_TIMEOUT_MS = 15_000;

const applicantSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

const workflowRunSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  applicant_id: z.string().optional(),
  workflow_id: z.string().optional(),
  status: z.string().optional(),
  output: z.unknown().optional(),
  reasons: z.array(z.string()).nullish(),
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).nullish(),
  sdk_token: z.string().nullish(),
});

type WorkflowRun = z.infer<typeof workflowRunSchema>;

const ONFIDO_DOCUMENT_TYPES: Readonly<Record<string, IdentityDocumentType>> = {
  passport: "passport",
  national_identity_card: "national_id",
  driving_licence: "driving_licence",
  residence_permit: "residence_permit",
};

export interface OnfidoClientOptions {
  readonly apiToken: string;
  readonly baseUrl: string;
  readonly workflows: Readonly<Partial<Record<KycJobType, string | undefined>>>;
}

export class OnfidoClient implements KycProvider {
  readonly name = "onfido" as const;

  constructor(
    private readonly options: OnfidoClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(jobType: KycJobType): boolean {
    return this.workflowFor(jobType) !== undefined;
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const workflowId = this.workflowFor(input.jobType);
    if (workflowId === undefined) {
      throw new KycProviderError(this.name, `aucun workflow configuré pour ${input.jobType}`, false);
    }
    const applicantId =
      input.existingApplicantReference ??
      applicantSchema.parse(
        await this.request("POST", "/applicants", {
          first_name: input.declared.firstName,
          last_name: input.declared.lastName,
          dob: input.declared.dateOfBirth,
          location: { country_of_residence: input.countryOfResidenceAlpha3 },
        }),
      ).id;

    const run = this.parseRun(
      await this.request("POST", "/workflow_runs", {
        workflow_id: workflowId,
        applicant_id: applicantId,
        customer_user_id: input.userId,
        tags: [`verification-${input.verificationId}`],
      }),
    );
    if (run.sdk_token === null || run.sdk_token === undefined || run.sdk_token.length === 0) {
      throw new KycProviderError(this.name, "jeton SDK absent de la réponse de création du run", false);
    }
    return {
      providerReference: run.id,
      applicantReference: applicantId,
      launch: { provider: "onfido", sdkToken: run.sdk_token, workflowRunId: run.id },
    };
  }

  async fetchOutcome(request: OutcomeRequest): Promise<ProviderOutcome> {
    const run = this.parseRun(await this.request("GET", `/workflow_runs/${encodeURIComponent(request.providerReference)}`, undefined));
    if (run.id !== request.providerReference) {
      throw new KycProviderError(this.name, "le run renvoyé ne correspond pas au run demandé", false);
    }
    const expectedWorkflow = this.workflowFor(request.jobType);
    if (run.workflow_id !== undefined && expectedWorkflow !== undefined && run.workflow_id !== expectedWorkflow) {
      throw new KycProviderError(this.name, "workflow du run différent du workflow configuré", false);
    }
    const status = run.status ?? "unknown";
    const summary: OutcomeSummary = {
      providerStatus: status,
      resultCode: run.error?.type ?? null,
      resultText: run.error?.message ?? null,
      reasons: (run.reasons ?? []).slice(0, 20),
    };
    switch (status) {
      case "approved":
        return { kind: "approved", summary, identity: extractOnfidoIdentity(run.output) };
      case "declined":
        return { kind: "rejected", summary, identity: extractOnfidoIdentity(run.output) };
      case "review":
        return { kind: "manual_review", summary, identity: extractOnfidoIdentity(run.output) };
      case "error":
        // Erreur de traitement chez le prestataire : décision humaine.
        return { kind: "manual_review", summary, identity: null };
      case "abandoned":
        return { kind: "abandoned", summary };
      case "processing":
      case "awaiting_input":
      case "awaiting_client_input":
        return { kind: "pending", summary };
      default:
        throw new KycProviderError(this.name, `statut de run inconnu : ${status}`, false);
    }
  }

  private workflowFor(jobType: KycJobType): string | undefined {
    return this.options.workflows[jobType];
  }

  private parseRun(body: unknown): WorkflowRun {
    const parsed = workflowRunSchema.safeParse(body);
    if (!parsed.success) throw new KycProviderError(this.name, "réponse de workflow run illisible", false);
    return parsed.data;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Token token=${this.options.apiToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new KycProviderError(this.name, "prestataire injoignable", true, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      // Le corps d'erreur Onfido ({ error: { type, message } }) ne contient pas
      // de donnée personnelle ; il est tronqué par prudence.
      throw new KycProviderError(
        this.name,
        `${method} ${path.split("/")[1] ?? ""} : HTTP ${response.status} ${text.slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new KycProviderError(this.name, "réponse JSON invalide", true, { cause: error });
    }
  }
}

function stringField(source: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Lecture tolérante mais typée de la sortie du workflow (voir en-tête). */
export function extractOnfidoIdentity(output: unknown): ExtractedIdentity | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const source = output as Readonly<Record<string, unknown>>;

  const firstName = stringField(source, "first_name");
  const lastName = stringField(source, "last_name");
  const fullName = firstName !== null && lastName !== null ? `${firstName} ${lastName}` : null;

  const rawBirth = stringField(source, "date_of_birth");
  const dateOfBirth = rawBirth === null ? null : parseIsoDate(rawBirth);

  const rawType = stringField(source, "document_type");
  const documentType = rawType === null ? null : (ONFIDO_DOCUMENT_TYPES[rawType] ?? null);

  let documentNumber = stringField(source, "document_number");
  const numbers = source["document_numbers"];
  if (documentNumber === null && Array.isArray(numbers)) {
    for (const entry of numbers as readonly unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Readonly<Record<string, unknown>>;
      if (record["type"] === "document_number" && typeof record["value"] === "string" && record["value"].trim().length > 0) {
        documentNumber = record["value"].trim();
        break;
      }
    }
  }

  const issuingCountry = stringField(source, "issuing_country");
  if (fullName === null && dateOfBirth === null && documentNumber === null) return null;
  return {
    documentType,
    issuingCountry: issuingCountry !== null && /^[A-Za-z]{2,3}$/.test(issuingCountry) ? issuingCountry.toUpperCase() : null,
    documentNumber,
    fullName,
    dateOfBirth,
  };
}
