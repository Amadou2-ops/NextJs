"use server";

import { confirmed, note } from "@/lib/forms";
import type { Approval, ApprovalOutcome } from "@/lib/types";
import { z } from "@/lib/zod";
import type { ActionResult, AdminActionState } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/**
 * Décision sur une demande à double validation. L'approbation exécute
 * l'action dans la même transaction (la base vérifie : approbateur ≠
 * demandeur, permission de l'action, contenu inchangé, demande non expirée).
 */

function describeOutcome(outcome: ApprovalOutcome): ActionResult {
  const enrollmentUrl = outcome.result["enrollmentUrl"];
  if (typeof enrollmentUrl === "string") {
    return { message: "Invitation approuvée : le compte est créé, en attente d'enrôlement.", secret: { label: "Lien d'enrôlement (usage unique, 48 h au plus)", value: enrollmentUrl } };
  }
  return { message: "Demande approuvée et exécutée." };
}

export async function approveAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  const schema = z.strictObject({ note: z.string().trim().max(2000).optional(), confirm: confirmed });
  return mutation(
    form,
    schema,
    (input) =>
      actionApi<ApprovalOutcome>({
        method: "POST",
        path: `/v1/admin/approvals/${id}/approve`,
        body: input.note === undefined || input.note.length === 0 ? {} : { note: input.note },
      }),
    describeOutcome,
  );
}

export async function rejectAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ note }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/approvals/${id}/reject`, body: { note: input.note } }),
    () => ({ message: "Demande refusée." }),
  );
}
