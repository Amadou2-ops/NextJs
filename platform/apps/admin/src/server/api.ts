import "server-only";

/**
 * Client HTTP de l'API du back-office, côté serveur uniquement. Seules les
 * routes /v1/admin/* sont atteignables. Chaque appel transmet l'adresse IP du
 * navigateur (contrôlée par l'API contre les plages autorisées du membre,
 * et liée aux défis WebAuthn) et son agent, avec un délai maximal. Les
 * erreurs de l'API (RFC 9457) sont converties en ApiError typée.
 */

export interface ClientContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string | null,
    readonly issues: readonly FieldIssue[],
  ) {
    super(`${status.toString()} ${code}`);
  }
}

export interface ApiRequest {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly path: `/v1/admin/${string}`;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly context: ClientContext;
}

export interface ApiTransport {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
}

function problemOf(status: number, payload: unknown): ApiError {
  if (typeof payload === "object" && payload !== null) {
    const problem = payload as { code?: unknown; title?: unknown; detail?: unknown; issues?: unknown };
    const issues = Array.isArray(problem.issues)
      ? problem.issues.filter((issue): issue is FieldIssue => typeof issue === "object" && issue !== null && typeof (issue as FieldIssue).path === "string" && typeof (issue as FieldIssue).message === "string")
      : [];
    return new ApiError(
      status,
      typeof problem.code === "string" ? problem.code : "UNKNOWN",
      typeof problem.title === "string" ? problem.title : "Erreur",
      typeof problem.detail === "string" ? problem.detail : null,
      issues,
    );
  }
  return new ApiError(status, status >= 500 ? "SERVICE_UNAVAILABLE" : "UNKNOWN", "Erreur", null, []);
}

export async function apiRequest<T>(transport: ApiTransport, request: ApiRequest): Promise<T> {
  const url = new URL(`${transport.baseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers = new Headers({ Accept: "application/json" });
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  if (request.accessToken !== undefined) headers.set("Authorization", `Bearer ${request.accessToken}`);
  if (request.context.ipAddress !== null) headers.set("X-Forwarded-For", request.context.ipAddress);
  if (request.context.userAgent !== null) headers.set("User-Agent", request.context.userAgent.slice(0, 512));

  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: request.method ?? "GET",
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(transport.timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error: unknown) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service indisponible", error instanceof Error && error.name === "TimeoutError" ? "Le service ne répond pas." : "Service momentanément indisponible.", []);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(502, "SERVICE_UNAVAILABLE", "Réponse invalide", "Le service a renvoyé une réponse illisible.", []);
    }
  }
  if (!response.ok) throw problemOf(response.status, payload);
  return payload as T;
}

/**
 * Adresse IP du navigateur, derrière `trustedHops` relais (répartiteur de
 * charge) : on lit X-Forwarded-For depuis la droite, jamais la valeur
 * fournie par le client lui-même.
 */
export function clientIpFrom(forwardedFor: string | null, trustedHops: number): string | null {
  if (forwardedFor === null) return null;
  const chain = forwardedFor.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const candidate = chain[chain.length - trustedHops];
  if (candidate === undefined) return null;
  return /^[0-9a-fA-F:.]{2,45}$/.test(candidate) ? candidate : null;
}
