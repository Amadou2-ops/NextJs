/**
 * Contrat commun des prestataires de vérification d'identité.
 *
 * Règle de confiance : le contenu d'un webhook n'est JAMAIS utilisé comme
 * résultat. Le webhook authentifié signale seulement qu'un dossier a changé ;
 * le résultat est relu auprès de l'API du prestataire (TLS, authentification
 * par secret serveur) via fetchOutcome().
 */

export type KycProviderName = "onfido" | "smile_id";
export type KycJobType = "document_verification" | "biometric_kyc" | "proof_of_address";
export type KycChannel = "mobile" | "web";
export type IdentityDocumentType = "passport" | "national_id" | "driving_licence" | "residence_permit";

/** Identité déclarée par le client (en clair uniquement en mémoire). */
export interface DeclaredIdentity {
  readonly firstName: string;
  readonly lastName: string;
  /** AAAA-MM-JJ */
  readonly dateOfBirth: string;
}

export interface StartSessionInput {
  readonly verificationId: string;
  readonly userId: string;
  readonly jobType: KycJobType;
  readonly channel: KycChannel;
  readonly declared: DeclaredIdentity;
  /** Pays de résidence ISO 3166-1 alpha-3 (format attendu par Onfido). */
  readonly countryOfResidenceAlpha3: string;
  readonly existingApplicantReference: string | null;
}

/** Paramètres de lancement du SDK de capture côté client. */
export type SdkLaunch =
  | {
      readonly provider: "onfido";
      readonly sdkToken: string;
      readonly workflowRunId: string;
    }
  | {
      readonly provider: "smile_id";
      readonly partnerId: string;
      readonly environment: "sandbox" | "production";
      readonly jobId: string;
      readonly userId: string;
      readonly jobType: number;
      readonly product: string;
      readonly callbackUrl: string;
      readonly signature: string;
      readonly timestamp: string;
      /** Jeton d'intégration web hébergée (canal web uniquement). */
      readonly webToken: string | null;
    };

export interface ProviderSession {
  /** Référence du dossier chez le prestataire (run Onfido, job_id Smile ID). */
  readonly providerReference: string;
  /** Dossier client chez le prestataire, créé ou réutilisé (Onfido). */
  readonly applicantReference: string | null;
  readonly launch: SdkLaunch;
}

/** Données d'identité lues sur la pièce par le prestataire. */
export interface ExtractedIdentity {
  readonly documentType: IdentityDocumentType | null;
  /** Code pays ISO 3166-1 alpha-2 ou alpha-3, tel que fourni. */
  readonly issuingCountry: string | null;
  readonly documentNumber: string | null;
  readonly fullName: string | null;
  /** AAAA-MM-JJ */
  readonly dateOfBirth: string | null;
}

/** Résumé non nominatif conservé avec la vérification. */
export interface OutcomeSummary {
  readonly providerStatus: string;
  readonly resultCode: string | null;
  readonly resultText: string | null;
  readonly reasons: readonly string[];
}

export type ProviderOutcome =
  /** Capture ou traitement en cours chez le prestataire. */
  | { readonly kind: "pending"; readonly summary: OutcomeSummary }
  /** Revue humaine en cours chez le prestataire. */
  | { readonly kind: "provider_review"; readonly summary: OutcomeSummary }
  /** Le prestataire renvoie la décision à notre équipe conformité. */
  | { readonly kind: "manual_review"; readonly summary: OutcomeSummary; readonly identity: ExtractedIdentity | null }
  | { readonly kind: "approved"; readonly summary: OutcomeSummary; readonly identity: ExtractedIdentity | null }
  | { readonly kind: "rejected"; readonly summary: OutcomeSummary; readonly identity: ExtractedIdentity | null }
  /** Le client n'a pas terminé la capture. */
  | { readonly kind: "abandoned"; readonly summary: OutcomeSummary };

export interface OutcomeRequest {
  readonly verificationId: string;
  readonly userId: string;
  readonly providerReference: string;
  readonly jobType: KycJobType;
}

export interface KycProvider {
  readonly name: KycProviderName;
  supports(jobType: KycJobType): boolean;
  startSession(input: StartSessionInput): Promise<ProviderSession>;
  fetchOutcome(request: OutcomeRequest): Promise<ProviderOutcome>;
}

export class KycProviderError extends Error {
  override readonly name = "KycProviderError";
  constructor(
    readonly provider: KycProviderName,
    message: string,
    readonly retryable: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(`${provider} : ${message}`, options);
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Valide une date calendaire AAAA-MM-JJ (année, mois et jour cohérents). */
export function parseIsoDate(value: string): string | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year ?? ""}-${month ?? ""}-${day ?? ""}`;
}

/** Âge révolu à une date donnée (UTC). */
export function ageOn(dateOfBirth: string, at: Date): number {
  const [year, month, day] = dateOfBirth.split("-").map(Number) as [number, number, number];
  let age = at.getUTCFullYear() - year;
  const beforeBirthday = at.getUTCMonth() + 1 < month || (at.getUTCMonth() + 1 === month && at.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Jetons de nom comparables : décomposition Unicode, suppression des
 * diacritiques, minuscules, séparateurs (espace, tiret, apostrophe) unifiés.
 * « Aïssatou N'Diaye-Ba » → ["aissatou", "n", "diaye", "ba"].
 */
export function nameTokens(value: string): readonly string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

export type IdentityMatch = { readonly match: true } | { readonly match: false; readonly reason: string } | { readonly match: null; readonly reason: string };

/**
 * Concordance identité déclarée / identité lue sur la pièce :
 *   - tous les jetons du prénom et du nom déclarés figurent dans le nom lu
 *     (les prénoms secondaires présents sur la pièce sont tolérés) ;
 *   - la date de naissance est identique lorsque le contrôle porte sur une
 *     pièce d'identité (exigée) ; une preuve de domicile n'en porte pas.
 */
export function matchDeclaredIdentity(
  declared: DeclaredIdentity,
  extracted: ExtractedIdentity | null,
  requireDateOfBirth: boolean,
): IdentityMatch {
  if (extracted?.fullName === null || extracted?.fullName === undefined) {
    return { match: null, reason: "name_unavailable" };
  }
  const read = new Set(nameTokens(extracted.fullName));
  const expected = [...nameTokens(declared.firstName), ...nameTokens(declared.lastName)];
  if (expected.length === 0 || read.size === 0) return { match: null, reason: "name_unavailable" };
  if (!expected.every((token) => read.has(token))) return { match: false, reason: "name_mismatch" };

  if (requireDateOfBirth) {
    if (extracted.dateOfBirth === null) return { match: null, reason: "date_of_birth_unavailable" };
    if (extracted.dateOfBirth !== declared.dateOfBirth) return { match: false, reason: "date_of_birth_mismatch" };
  } else if (extracted.dateOfBirth !== null && extracted.dateOfBirth !== declared.dateOfBirth) {
    return { match: false, reason: "date_of_birth_mismatch" };
  }
  return { match: true };
}

/** Numéro de pièce normalisé pour l'index aveugle (sans espaces ni séparateurs). */
export function normalizeDocumentNumber(value: string): string | null {
  const normalized = value.normalize("NFKC").replace(/[\s./-]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,40}$/.test(normalized) ? normalized : null;
}
