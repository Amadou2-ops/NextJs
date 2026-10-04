import "server-only";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { userMessage } from "@/lib/errors";

import { ApiError } from "./api";

/**
 * Résultat d'une action serveur, consommé par useActionState. Les erreurs de
 * l'API sont traduites en messages clients ; toute autre erreur est relancée
 * (journalisée par Next, page d'erreur générique, aucune fuite de détail).
 */

export type ActionState<T = undefined> =
  | { readonly status: "idle" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly fields: Readonly<Record<string, string>>;
      /** Saisie à réafficher (React réinitialise le formulaire après l'action). Jamais de secret. */
      readonly values?: Readonly<Record<string, string>>;
    }
  | { readonly status: "success"; readonly data: T };

export const IDLE: ActionState<never> = { status: "idle" };

export type ActionFailure = Extract<ActionState<never>, { readonly status: "error" }>;

export function failure(message: string, fields: Readonly<Record<string, string>> = {}): ActionFailure {
  return { status: "error", message, fields };
}

export function fromError(error: unknown): ActionState<never> {
  unstable_rethrow(error);
  if (error instanceof ApiError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const field = issue.path.replace(/^body\./, "");
      fields[field] ??= issue.message;
    }
    return failure(userMessage(error.code, error.detail), fields);
  }
  throw error;
}

/** Champs jamais renvoyés au navigateur après une erreur. */
const SECRET_FIELDS: ReadonlySet<string> = new Set(["password", "passwordConfirmation"]);

function submittedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION") && !SECRET_FIELDS.has(key)) values[key] = value.slice(0, 500);
  }
  return values;
}

/** Erreur d'action accompagnée de la saisie non secrète, pour la réafficher. */
export function keepValues<T>(state: ActionState<T>, form: FormData): ActionState<T> {
  return state.status === "error" ? { ...state, values: submittedValues(form) } : state;
}

/** Lit un formulaire avec un schéma strict ; erreurs par champ. */
export function parseForm<T>(schema: z.ZodType<T>, form: FormData): { readonly ok: true; readonly data: T } | { readonly ok: false; readonly state: ActionState<never> } {
  // Un champ répété (cases à cocher) devient une liste.
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string" || key.startsWith("$ACTION")) continue;
    const existing = raw[key];
    raw[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) fields[issue.path.join(".")] ??= issue.message;
  return { ok: false, state: { ...failure("Certaines informations sont invalides.", fields), values: submittedValues(form) } };
}

/** Issue d'une action du back-office : message, et éventuellement une valeur à transmettre une seule fois. */
export interface ActionResult {
  readonly message: string;
  readonly secret?: { readonly label: string; readonly value: string };
}

export type AdminActionState = ActionState<ActionResult>;
