"use server";

import { justification, note } from "@/lib/forms";
import type { AmlAlertDetail, AmlCaseDetail, Approval } from "@/lib/types";
import { z } from "@/lib/zod";
import type { AdminActionState } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/** Traitement des alertes LCB-FT et des dossiers d'enquête. */

export async function assignAlertAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({}),
    () => actionApi<AmlAlertDetail>({ method: "POST", path: `/v1/admin/aml/alerts/${id}/assign` }),
    () => ({ message: "Alerte attribuée : elle passe en revue." }),
  );
}

export async function escalateAlertAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ note }),
    (input) => actionApi<AmlAlertDetail>({ method: "POST", path: `/v1/admin/aml/alerts/${id}/escalate`, body: { note: input.note } }),
    () => ({ message: "Alerte escaladée." }),
  );
}

export async function resolveAlertAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ outcome: z.enum(["false_positive", "confirmed"]), note }),
    (input) => actionApi<AmlAlertDetail>({ method: "POST", path: `/v1/admin/aml/alerts/${id}/resolve`, body: input }),
    (_output, input) => ({ message: input.outcome === "confirmed" ? "Alerte close comme confirmée." : "Alerte close comme faux positif." }),
  );
}

export async function transitionCaseAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ status: z.enum(["investigating", "closed"]), note }),
    (input) => actionApi<AmlCaseDetail>({ method: "POST", path: `/v1/admin/aml/cases/${id}/status`, body: input }),
    (_output, input) => ({ message: input.status === "closed" ? "Dossier clos." : "Dossier passé en enquête." }),
  );
}

const alertIds = z.preprocess(
  (value) => (typeof value === "string" ? value.split(/[\s,]+/).filter((part) => part.length > 0) : value),
  z.array(z.uuid("identifiant d'alerte invalide")).min(1, "au moins une alerte").max(100),
);

export async function linkAlertsAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ alertIds }),
    (input) => actionApi<AmlCaseDetail>({ method: "POST", path: `/v1/admin/aml/cases/${id}/alerts`, body: { alertIds: input.alertIds } }),
    (_output, input) => ({ message: `${input.alertIds.length.toString()} alerte(s) rattachée(s) au dossier.` }),
  );
}

export async function requestSarAction(id: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ sarReference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{2,99}$/, "référence invalide (lettres, chiffres, / _ . -)"), justification }),
    (input) => actionApi<Approval>({ method: "POST", path: `/v1/admin/aml/cases/${id}/sar-requests`, body: input }),
    () => ({ message: "Demande d'enregistrement de la déclaration créée : un second membre doit l'approuver." }),
  );
}
