"use client";

import { useActionState } from "react";

import { FieldError, FormMessage } from "@/components/FormStatus";
import type { ActionState } from "@/server/actionState";

import { verifyLoginAction } from "../actions";

export function CodeForm(): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(verifyLoginAction, { status: "idle" });
  const fields = state.status === "error" ? state.fields : undefined;
  return (
    <form action={action} className="card stack" noValidate>
      <FormMessage state={state} />
      <label>
        Code à 6 chiffres
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required aria-invalid={fields?.["code"] !== undefined} aria-describedby="code-erreur" />
        <FieldError fields={fields} name="code" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Vérification…" : "Valider"}
      </button>
    </form>
  );
}
