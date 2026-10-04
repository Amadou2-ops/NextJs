/**
 * Hiérarchie d'erreurs de l'API et traduction des erreurs PostgreSQL.
 *
 * Chaque erreur porte un code métier stable (contrat OpenAPI, ErrorCode), un
 * statut HTTP et un message destiné au client. Les détails internes (SQL,
 * piles d'appel, identifiants de comptes système) ne quittent jamais le
 * serveur : ils sont journalisés, pas renvoyés.
 */

export const ERROR_CODES = [
  "INSUFFICIENT_FUNDS",
  "UNBALANCED_JOURNAL",
  "ACCOUNT_NOT_POSTABLE",
  "CURRENCY_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "IMMUTABLE_RECORD",
  "INVALID_LEDGER_INPUT",
  "INVALID_REVERSAL",
  "LEDGER_CHAIN_BROKEN",
  "INVALID_STATUS_TRANSITION",
  "QUOTE_EXPIRED_OR_CONSUMED",
  "INVALID_PAYMENT_TRANSITION",
  "FOUR_EYES_VIOLATION",
  "KYC_LIMIT_EXCEEDED",
  "COMPLIANCE_BLOCKED",
  "INVALID_CREDENTIALS",
  "INVALID_VERIFICATION_CODE",
  "VERIFICATION_EXPIRED",
  "ACCOUNT_LOCKED",
  "DEVICE_ATTESTATION_FAILED",
  "DEVICE_SIGNATURE_INVALID",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "REQUEST_IN_PROGRESS",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export interface AppErrorOptions {
  readonly detail?: string;
  readonly cause?: unknown;
  readonly issues?: readonly FieldIssue[];
  readonly retryAfterSeconds?: number;
  /** Contexte journalisé côté serveur, jamais renvoyé au client. */
  readonly internalContext?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly detail: string | undefined;
  readonly issues: readonly FieldIssue[] | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly internalContext: Readonly<Record<string, unknown>> | undefined;

  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    readonly title: string,
    options: AppErrorOptions = {},
  ) {
    super(options.detail ?? title, options.cause === undefined ? undefined : { cause: options.cause });
    this.detail = options.detail;
    this.issues = options.issues;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.internalContext = options.internalContext;
  }

  /** Une erreur 5xx est un défaut du service : à journaliser en erreur. */
  get isServerError(): boolean {
    return this.httpStatus >= 500;
  }
}

export class ValidationError extends AppError {
  override readonly name = "ValidationError";
  constructor(issues: readonly FieldIssue[], detail = "La requête contient des données invalides.") {
    super("VALIDATION_FAILED", 400, "Données invalides", { detail, issues });
  }
}

export class AuthenticationError extends AppError {
  override readonly name = "AuthenticationError";
  constructor(detail = "Authentification requise.", internalContext?: Readonly<Record<string, unknown>>) {
    super("UNAUTHENTICATED", 401, "Non authentifié", internalContext === undefined ? { detail } : { detail, internalContext });
  }
}

export class ForbiddenError extends AppError {
  override readonly name = "ForbiddenError";
  constructor(detail = "Action non autorisée.", internalContext?: Readonly<Record<string, unknown>>) {
    super("FORBIDDEN", 403, "Accès refusé", internalContext === undefined ? { detail } : { detail, internalContext });
  }
}

export class NotFoundError extends AppError {
  override readonly name = "NotFoundError";
  constructor(detail = "Ressource introuvable.") {
    super("NOT_FOUND", 404, "Introuvable", { detail });
  }
}

export class ConflictError extends AppError {
  override readonly name = "ConflictError";
  constructor(code: Extract<ErrorCode, "CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REQUEST_IN_PROGRESS">, detail: string, status = 409) {
    super(code, status, "Conflit", { detail });
  }
}

export class RateLimitedError extends AppError {
  override readonly name = "RateLimitedError";
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", 429, "Trop de requêtes", {
      detail: "Trop de requêtes. Réessayez plus tard.",
      retryAfterSeconds,
    });
  }
}

export class ServiceUnavailableError extends AppError {
  override readonly name = "ServiceUnavailableError";
  constructor(detail = "Service momentanément indisponible.", cause?: unknown, retryAfterSeconds = 5) {
    super("SERVICE_UNAVAILABLE", 503, "Service indisponible", { detail, cause, retryAfterSeconds });
  }
}

export class InternalError extends AppError {
  override readonly name = "InternalError";
  constructor(cause?: unknown, internalContext?: Readonly<Record<string, unknown>>) {
    super("INTERNAL_ERROR", 500, "Erreur interne", {
      detail: "Une erreur interne est survenue. Elle a été enregistrée.",
      cause,
      ...(internalContext === undefined ? {} : { internalContext }),
    });
  }
}

/**
 * Erreur financière : levée par le registre ou les règles métier. Son code
 * et son message client sont fixés par le SQLSTATE d'origine.
 */
export class FinancialError extends AppError {
  override readonly name = "FinancialError";
  constructor(
    code: ErrorCode,
    httpStatus: number,
    title: string,
    readonly sqlState: string | undefined,
    options: AppErrorOptions,
  ) {
    super(code, httpStatus, title, options);
  }
}

interface SqlStateMapping {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly clientDetail: string;
}

/**
 * Codes SQLSTATE applicatifs (registre dans db/migrations/0001) et codes
 * PostgreSQL standards traduits en erreurs d'API.
 */
const SQLSTATE_MAPPINGS: Readonly<Record<string, SqlStateMapping>> = {
  LG001: { code: "INSUFFICIENT_FUNDS", status: 422, title: "Solde insuffisant", clientDetail: "Le solde disponible est insuffisant pour cette opération." },
  LG002: { code: "UNBALANCED_JOURNAL", status: 500, title: "Écriture comptable invalide", clientDetail: "L'opération n'a pas pu être enregistrée." },
  LG003: { code: "ACCOUNT_NOT_POSTABLE", status: 423, title: "Compte indisponible", clientDetail: "Ce compte ne peut pas être mouvementé actuellement." },
  LG004: { code: "CURRENCY_MISMATCH", status: 422, title: "Devise incohérente", clientDetail: "La devise ne correspond pas au compte." },
  LG005: { code: "IDEMPOTENCY_CONFLICT", status: 422, title: "Requête rejouée avec un contenu différent", clientDetail: "Cette clé d'idempotence a déjà été utilisée pour une autre opération." },
  LG006: { code: "IMMUTABLE_RECORD", status: 409, title: "Enregistrement non modifiable", clientDetail: "Cet enregistrement ne peut plus être modifié." },
  LG007: { code: "INVALID_LEDGER_INPUT", status: 422, title: "Opération invalide", clientDetail: "Les paramètres de l'opération sont invalides." },
  LG008: { code: "INVALID_REVERSAL", status: 409, title: "Annulation impossible", clientDetail: "Cette opération ne peut pas être annulée." },
  LG009: { code: "LEDGER_CHAIN_BROKEN", status: 500, title: "Incohérence du registre", clientDetail: "L'opération n'a pas pu être enregistrée." },
  TR001: { code: "INVALID_STATUS_TRANSITION", status: 409, title: "Changement de statut impossible", clientDetail: "Ce changement de statut n'est pas autorisé." },
  TR002: { code: "QUOTE_EXPIRED_OR_CONSUMED", status: 409, title: "Devis invalide", clientDetail: "Le devis a expiré ou a déjà été utilisé. Demandez un nouveau devis." },
  PY001: { code: "INVALID_PAYMENT_TRANSITION", status: 409, title: "Changement de statut de paiement impossible", clientDetail: "Ce changement de statut de paiement n'est pas autorisé." },
  KY001: {
    code: "KYC_LIMIT_EXCEEDED",
    status: 403,
    title: "Plafond de vérification atteint",
    clientDetail: "Ce transfert dépasse les plafonds de votre niveau de vérification d'identité. Complétez votre vérification pour les relever.",
  },
  AM001: {
    code: "COMPLIANCE_BLOCKED",
    status: 403,
    title: "Opération bloquée par la conformité",
    clientDetail: "Votre compte ne permet plus d'émettre de transfert. Contactez le service client.",
  },
  BO001: { code: "FOUR_EYES_VIOLATION", status: 403, title: "Double validation requise", clientDetail: "Cette action exige l'approbation d'un second membre habilité." },
};

/** SQLSTATE sur lesquels une transaction peut être rejouée sans risque. */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

/** SQLSTATE traduisant une indisponibilité transitoire de la base. */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000", "08001", "08003", "08004", "08006", // connection_exception
]);

export interface PostgresErrorLike {
  readonly code: string;
  readonly message: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly schema?: string;
}

export function isPostgresError(error: unknown): error is PostgresErrorLike {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
  );
}

export function sqlStateOf(error: unknown): string | undefined {
  return isPostgresError(error) ? error.code : undefined;
}

/** Traduit une erreur quelconque en AppError exposable. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (isPostgresError(error)) {
    const mapping = SQLSTATE_MAPPINGS[error.code];
    if (mapping !== undefined) {
      return new FinancialError(mapping.code, mapping.status, mapping.title, error.code, {
        detail: mapping.clientDetail,
        cause: error,
        internalContext: { sqlState: error.code, databaseMessage: error.message },
      });
    }
    if (error.code === "23505") {
      return new AppError("CONFLICT", 409, "Conflit", {
        detail: "Cette ressource existe déjà.",
        cause: error,
        internalContext: { sqlState: error.code, constraint: error.constraint, table: error.table },
      });
    }
    if (error.code === "23503" || error.code === "23514" || error.code === "22P02" || error.code === "22003") {
      return new AppError("VALIDATION_FAILED", 422, "Données refusées", {
        detail: "Les données fournies ne respectent pas les règles de la plateforme.",
        cause: error,
        internalContext: { sqlState: error.code, constraint: error.constraint, table: error.table },
      });
    }
    if (RETRYABLE_SQLSTATES.has(error.code) || UNAVAILABLE_SQLSTATES.has(error.code)) {
      return new ServiceUnavailableError("Service momentanément saturé. Réessayez dans quelques secondes.", error);
    }
    if (error.code === "42501") {
      // Privilège refusé : défaut de configuration, jamais la faute du client.
      return new InternalError(error, { sqlState: error.code, databaseMessage: error.message });
    }
  }

  return new InternalError(error);
}

/** Corps RFC 9457 (application/problem+json). */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly issues?: readonly FieldIssue[];
}

export function toProblem(error: AppError, requestId: string | undefined, instance: string | undefined): ProblemDocument {
  return {
    type: `https://docs.transfertplus.example/errors/${error.code.toLowerCase().replaceAll("_", "-")}`,
    title: error.title,
    status: error.httpStatus,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(instance === undefined ? {} : { instance }),
    code: error.code,
    ...(requestId === undefined ? {} : { requestId }),
    ...(error.issues === undefined ? {} : { issues: error.issues }),
  };
}
