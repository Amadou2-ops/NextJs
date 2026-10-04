"use server";

import { revalidatePath } from "next/cache";

import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError } from "@/server/actionState";
import { actionApi } from "@/server/context";

/** Annulation d'un transfert non encore payé ou non encore parti (remboursement automatique). */
export async function cancelTransferAction(transferId: string): Promise<ActionState> {
  if (!z.uuid().safeParse(transferId).success) return failure("Transfert introuvable.");
  try {
    await actionApi({ method: "POST", path: `/v1/transfers/${transferId}/cancel` });
  } catch (error: unknown) {
    return fromError(error);
  }
  revalidatePath(`/transferts/${transferId}`);
  return { status: "success", data: undefined };
}
