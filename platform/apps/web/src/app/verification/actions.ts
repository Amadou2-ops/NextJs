"use server";

import { revalidatePath } from "next/cache";

import type { KycLaunch, KycVerification } from "@/lib/types";
import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { actionApi } from "@/server/context";

/**
 * Vérification d'identité : ouverture d'une session de capture chez le
 * prestataire choisi par l'API (pays de résidence), puis signalement de fin
 * de capture. La décision vient du prestataire (webhook signé) ou d'une
 * revue manuelle ; le niveau est relevé par la base.
 */

const startSchema = z.strictObject({
  tier: z.enum(["tier_1", "tier_2"]),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  dateOfBirth: z.iso.date("Date de naissance invalide").optional(),
});

export interface KycStart {
  readonly verification: KycVerification;
  readonly launch: KycLaunch;
}

export async function startKycAction(_previous: ActionState<KycStart>, form: FormData): Promise<ActionState<KycStart>> {
  const parsed = parseForm(startSchema, form);
  if (!parsed.ok) return parsed.state;
  const { tier, firstName, lastName, dateOfBirth } = parsed.data;
  const declared = firstName !== undefined && lastName !== undefined && dateOfBirth !== undefined && firstName.length > 0 && lastName.length > 0;
  try {
    const started = await actionApi<KycStart>({
      method: "POST",
      path: "/v1/kyc/verifications",
      body: { tier, ...(declared ? { declaredIdentity: { firstName, lastName, dateOfBirth } } : {}) },
    });
    return { status: "success", data: started };
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
}

export async function markKycSubmittedAction(verificationId: string): Promise<ActionState> {
  if (!z.uuid().safeParse(verificationId).success) return failure("Vérification introuvable.");
  try {
    await actionApi({ method: "POST", path: `/v1/kyc/verifications/${verificationId}/submitted` });
  } catch (error: unknown) {
    return fromError(error);
  }
  revalidatePath("/verification");
  return { status: "success", data: undefined };
}
