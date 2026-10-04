"use server";

import { checkboxList, ipRanges, justification } from "@/lib/forms";
import type { Approval, StaffMember } from "@/lib/types";
import { STAFF_ROLES } from "@/lib/types";
import { z } from "@/lib/zod";
import type { AdminActionState } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/**
 * Gestion du personnel. Ce qui accorde des droits (invitation, rôles,
 * réseau, réactivation) passe par la double validation ; ce qui en retire
 * (suspension, désactivation, retrait de rôle) est immédiat.
 */

const roles = checkboxList(z.enum(STAFF_ROLES)).pipe(z.array(z.enum(STAFF_ROLES)).min(1, "au moins un rôle"));
const FOUR_EYES_MESSAGE = "Demande créée : un second membre habilité doit l'approuver.";

export async function inviteStaffAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    z.strictObject({
      email: z.email("adresse e-mail invalide").max(254),
      fullName: z.string().trim().min(2).max(120),
      roles,
      allowedIpRanges: ipRanges,
      justification,
    }),
    (input) => actionApi<Approval>({ method: "POST", path: "/v1/admin/staff/invitations", body: input }),
    () => ({ message: `${FOUR_EYES_MESSAGE} Le lien d'enrôlement sera remis à l'approbateur.` }),
  );
}

export async function requestRolesAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ roles, justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/staff/${id}/role-requests`, body: input }),
    () => ({ message: FOUR_EYES_MESSAGE }),
  );
}

export async function requestNetworkAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ allowedIpRanges: ipRanges, justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/staff/${id}/network-requests`, body: input }),
    () => ({ message: FOUR_EYES_MESSAGE }),
  );
}

export async function requestReactivationAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/staff/${id}/reactivation-requests`, body: input }),
    () => ({ message: FOUR_EYES_MESSAGE }),
  );
}

export async function restrictStaffAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ status: z.enum(["suspended", "disabled"]), reason: justification, confirm: z.literal("yes", "Confirmation requise") }),
    (input) => actionApi<StaffMember>({ method: "POST", path: `/v1/admin/staff/${id}/restriction`, body: { status: input.status, reason: input.reason } }),
    (_output, input) => ({
      message: input.status === "disabled" ? "Compte désactivé définitivement : sessions, clés et invitations révoquées." : "Compte suspendu : toutes ses sessions sont révoquées.",
    }),
  );
}

export async function revokeRoleAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ role: z.enum(STAFF_ROLES), reason: justification }),
    (input) => actionApi<StaffMember>({ method: "DELETE", path: `/v1/admin/staff/${id}/roles/${input.role}`, body: { reason: input.reason } }),
    () => ({ message: "Rôle retiré : effet immédiat." }),
  );
}

export async function renewInvitationAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({}),
    () => actionApi<{ enrollmentUrl: string; invitationExpiresAt: string }>({ method: "POST", path: `/v1/admin/staff/${id}/invitation` }),
    (output) => ({ message: "Nouvelle invitation émise ; la précédente est révoquée.", secret: { label: "Lien d'enrôlement (usage unique)", value: output.enrollmentUrl } }),
  );
}
