"use server";

import { revalidatePath } from "next/cache";

import { adjustmentEntries, adjustmentFormSchema } from "@/lib/adjustment";
import { justification } from "@/lib/forms";
import type { Approval } from "@/lib/types";
import { z } from "@/lib/zod";
import type { AdminActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/**
 * Demandes de modification du registre, toutes à double validation : gel ou
 * dégel d'un compte, contre-passation d'un journal, ajustement manuel. Le
 * registre lui-même reste immuable : un ajustement est un nouveau journal
 * équilibré, une contre-passation un journal miroir.
 */

export async function requestAccountStatusAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ status: z.enum(["frozen", "active"]), reason: justification, justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/ledger/accounts/${id}/status-requests`, body: input }),
    (_output, input) => ({ message: `Demande de ${input.status === "frozen" ? "gel" : "dégel"} créée : un second membre doit l'approuver.` }),
  );
}

export async function requestReversalAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ reason: justification, justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/ledger/journals/${id}/reversal-requests`, body: input }),
    () => ({ message: "Demande de contre-passation créée : un second membre doit l'approuver." }),
  );
}

export async function requestAdjustmentAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  const parsed = parseForm(adjustmentFormSchema, form);
  if (!parsed.ok) return parsed.state;
  const built = adjustmentEntries(parsed.data);
  if ("error" in built) return keepValues(failure(built.error), form);
  try {
    await actionApi<Approval>({
      method: "POST",
      path: "/v1/admin/ledger/adjustment-requests",
      body: { description: parsed.data.description, justification: parsed.data.justification, entries: built.entries },
    });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  revalidatePath("/", "layout");
  return { status: "success", data: { message: "Demande d'ajustement créée : un second membre doit l'approuver avant toute écriture." } };
}
