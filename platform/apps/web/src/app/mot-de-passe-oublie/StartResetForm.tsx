"use client";

import { useActionState } from "react";

import { FieldError, FormMessage, previous } from "@/components/FormStatus";
import { SENDING_COUNTRIES } from "@/lib/format";
import type { ActionState } from "@/server/actionState";

import { startPasswordResetAction } from "./actions";

export function StartResetForm(): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(startPasswordResetAction, { status: "idle" });
  const fields = state.status === "error" ? state.fields : undefined;
  return (
    <form action={action} className="card stack" noValidate>
      <FormMessage state={state} />
      <label>
        Pays
        <select name="country" defaultValue={previous(state, "country") ?? "FR"} aria-invalid={fields?.["country"] !== undefined}>
          {SENDING_COUNTRIES.map((item) => (
            <option key={item.country} value={item.country}>
              {item.name}
            </option>
          ))}
        </select>
        <FieldError fields={fields} name="country" />
      </label>
      <label>
        Numéro de téléphone du compte
        <input name="phone" defaultValue={previous(state, "phone")} type="tel" autoComplete="tel" required aria-invalid={fields?.["phone"] !== undefined} aria-describedby="phone-erreur" />
        <FieldError fields={fields} name="phone" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Envoi du code…" : "Recevoir un code par SMS"}
      </button>
    </form>
  );
}
