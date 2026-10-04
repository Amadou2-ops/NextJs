import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult, AdminActionState } from "./actionState";
import { failure, fromError, keepValues, parseForm } from "./actionState";

/**
 * Exécution d'une action du personnel : lecture stricte du formulaire,
 * appel à l'API, traduction des erreurs, rafraîchissement des vues (sauf
 * quand le résultat porte une valeur à usage unique à afficher). Les
 * identifiants liés à l'action (`.bind`) transitent par le navigateur : ils
 * sont revalidés ici comme toute entrée.
 */

const uuid = z.uuid();

export function validId(value: string): boolean {
  return uuid.safeParse(value).success;
}

export async function mutation<Input, Output>(
  form: FormData,
  schema: z.ZodType<Input>,
  call: (input: Input) => Promise<Output>,
  describe: (output: Output, input: Input) => ActionResult,
  options: { readonly refresh: boolean } = { refresh: true },
): Promise<AdminActionState> {
  const parsed = parseForm(schema, form);
  if (!parsed.ok) return parsed.state;
  let output: Output;
  try {
    output = await call(parsed.data);
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  const result = describe(output, parsed.data);
  // Une valeur à usage unique (lien d'enrôlement) ne doit pas disparaître avec
  // le formulaire lors du rafraîchissement de la page : pas de rafraîchissement.
  if (options.refresh && result.secret === undefined) revalidatePath("/", "layout");
  return { status: "success", data: result };
}

export function invalidTarget(): AdminActionState {
  return failure("Élément invalide.");
}
