"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";

import type { CustomerPii } from "@/lib/types";
import type { ActionState } from "@/server/actionState";

const LABELS: Readonly<Record<keyof CustomerPii, string>> = {
  firstName: "Prénom",
  lastName: "Nom",
  dateOfBirth: "Date de naissance",
  phone: "Téléphone",
  email: "E-mail",
};

/** Déchiffrement à la demande ; les données ne sont conservées que dans l'affichage courant. */
export function PiiReveal({ action }: { readonly action: (state: ActionState<CustomerPii>, form: FormData) => Promise<ActionState<CustomerPii>> }): ReactNode {
  const [state, dispatch, pending] = useActionState<ActionState<CustomerPii>, FormData>(action, { status: "idle" });
  if (state.status === "success") {
    return (
      <div className="card">
        <h3>Données personnelles</h3>
        <dl className="details">
          {(Object.keys(LABELS) as (keyof CustomerPii)[]).map((key) => (
            <div key={key}>
              <dt>{LABELS[key]}</dt>
              <dd>{state.data[key] ?? "—"}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small">Consultation enregistrée au journal d&apos;audit avec votre justification.</p>
      </div>
    );
  }
  return (
    <form action={dispatch} className="card stack">
      <h3>Afficher les données personnelles</h3>
      {state.status === "error" && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      <label>
        Justification (consignée au journal d&apos;audit)
        <textarea name="justification" required minLength={10} maxLength={1000} rows={2} defaultValue={state.status === "error" ? state.values?.["justification"] : undefined} />
        {state.status === "error" && state.fields["justification"] !== undefined && <span className="field-error">{state.fields["justification"]}</span>}
      </label>
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Déchiffrement…" : "Déchiffrer"}
      </button>
    </form>
  );
}
