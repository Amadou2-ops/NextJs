"use server";

import { redirect } from "next/navigation";

import { justification } from "@/lib/forms";
import type { AmlCaseDetail, CustomerPii, CustomerSummary } from "@/lib/types";
import { z } from "@/lib/zod";
import type { ActionState, AdminActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/** Données personnelles en clair : sur justification, tracées au journal d'audit, jamais mises en cache. */
export async function revealPiiAction(id: string, _previous: ActionState<CustomerPii>, form: FormData): Promise<ActionState<CustomerPii>> {
  if (!validId(id)) return failure("Client invalide.");
  const parsed = parseForm(z.strictObject({ justification }), form);
  if (!parsed.ok) return parsed.state;
  try {
    const pii = await actionApi<CustomerPii>({ method: "POST", path: `/v1/admin/customers/${id}/pii`, body: { justification: parsed.data.justification } });
    return { status: "success", data: pii };
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
}

const CUSTOMER_STATUSES = new Set(["suspended", "active"]);

export async function setCustomerStatusAction(id: string, status: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  // Arguments liés transitant par le navigateur : revalidés.
  if (!validId(id) || !CUSTOMER_STATUSES.has(status)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ reason: justification }),
    (input) => actionApi<CustomerSummary>({ method: "POST", path: `/v1/admin/customers/${id}/status`, body: { status, reason: input.reason } }),
    () => ({ message: status === "suspended" ? "Client suspendu : toutes ses sessions sont révoquées." : "Client rétabli." }),
  );
}

export async function openCaseAction(userId: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(userId)) return invalidTarget();
  const parsed = parseForm(z.strictObject({ summary: z.string().trim().min(10, "10 caractères au moins").max(5000) }), form);
  if (!parsed.ok) return parsed.state;
  let created: AmlCaseDetail;
  try {
    created = await actionApi<AmlCaseDetail>({ method: "POST", path: "/v1/admin/aml/cases", body: { userId, summary: parsed.data.summary, alertIds: [] } });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  redirect(`/aml/dossiers/${created.id}`);
}
