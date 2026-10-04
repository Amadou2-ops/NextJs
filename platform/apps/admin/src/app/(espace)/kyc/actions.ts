"use server";

import { checkboxList, note } from "@/lib/forms";
import type { KycDetail } from "@/lib/types";
import { z } from "@/lib/zod";
import type { ActionState, AdminActionState } from "@/server/actionState";
import { failure, fromError } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

import { KYC_REASONS } from "./reasons";


const REASON_CODES = KYC_REASONS.map(([code]) => code);

const decisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject", "resubmission_required"]),
  reasons: checkboxList(z.enum(REASON_CODES)).pipe(z.array(z.enum(REASON_CODES)).max(10)),
  note,
});

export async function decideKycAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    decisionSchema,
    (input) => actionApi<KycDetail>({ method: "POST", path: `/v1/admin/kyc/verifications/${id}/decision`, body: input }),
    (_output, input) => ({
      message: input.decision === "approve" ? "Vérification approuvée : le niveau du client est relevé." : input.decision === "reject" ? "Vérification refusée." : "Nouvelle pièce demandée au client.",
    }),
  );
}

export type RevealedIdentity = NonNullable<NonNullable<KycDetail["evidence"]>["identity"]>;

/** Identité extraite de la pièce, déchiffrée à la demande (exige aussi customers:read_pii ; tracé). */
export async function revealKycIdentityAction(id: string, _previous: ActionState<RevealedIdentity>): Promise<ActionState<RevealedIdentity>> {
  if (!validId(id)) return failure("Vérification invalide.");
  try {
    const detail = await actionApi<KycDetail>({ path: `/v1/admin/kyc/verifications/${id}`, query: { reveal: "identity" } });
    const identity = detail.evidence?.identity;
    return identity === null || identity === undefined ? failure("Aucune identité extraite pour cette vérification.") : { status: "success", data: identity };
  } catch (error: unknown) {
    return fromError(error);
  }
}
