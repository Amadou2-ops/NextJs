"use server";

import { justification, note } from "@/lib/forms";
import type { Approval, TransferDetail } from "@/lib/types";
import { z } from "@/lib/zod";
import type { AdminActionState } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/** Décisions de conformité sur un transfert ; le remboursement passe par la double validation. */

export async function holdTransferAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ reason: justification }),
    (input) => actionApi<TransferDetail>({ method: "POST", path: `/v1/admin/transfers/${id}/hold`, body: { reason: input.reason } }),
    () => ({ message: "Transfert placé en revue de conformité : il ne sera pas versé avant libération." }),
  );
}

export async function releaseTransferAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ note }),
    (input) => actionApi<TransferDetail>({ method: "POST", path: `/v1/admin/transfers/${id}/release`, body: { note: input.note } }),
    () => ({ message: "Transfert libéré : le versement reprend." }),
  );
}

export async function requestRefundAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ reason: justification, justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/transfers/${id}/refund-requests`, body: { reason: input.reason, justification: input.justification } }),
    () => ({ message: "Demande de remboursement créée : elle doit être approuvée par un second membre." }),
  );
}
