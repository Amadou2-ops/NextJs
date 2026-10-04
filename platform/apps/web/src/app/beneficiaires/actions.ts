"use server";

import { revalidatePath } from "next/cache";

import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError } from "@/server/actionState";
import { actionApi } from "@/server/context";

/** Archivage d'un bénéficiaire (ses coordonnées ne sont jamais modifiées, seulement retirées). */
export async function archiveRecipientAction(recipientId: string): Promise<ActionState> {
  if (!z.uuid().safeParse(recipientId).success) return failure("Bénéficiaire introuvable.");
  try {
    await actionApi({ method: "DELETE", path: `/v1/recipients/${recipientId}` });
  } catch (error: unknown) {
    return fromError(error);
  }
  revalidatePath("/beneficiaires");
  return { status: "success", data: undefined };
}
