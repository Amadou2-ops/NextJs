import type { Route } from "next";

/** Chemin interne avec paramètres de requête (valeurs vides omises). */
export function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): Route {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return (query.length > 0 ? `${path}?${query}` : path) as Route;
}

/** Paramètre de recherche simple (une seule valeur), sinon undefined. */
export function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Valeur acceptée seulement si elle appartient à la liste. */
export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export type IdParams = Promise<{ id: string }>;
