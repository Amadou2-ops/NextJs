"use client";

import { useActionState } from "react";

import { FieldError, FormMessage } from "@/components/FormStatus";
import type { ActionState } from "@/server/actionState";

import { completeRegistrationAction } from "../actions";

export function ConfirmationForm(): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(completeRegistrationAction, { status: "idle" });
  const fields = state.status === "error" ? state.fields : undefined;
  return (
    <form action={action} className="card stack" noValidate>
      <FormMessage state={state} />
      <label>
        Code reçu par SMS
        <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required aria-invalid={fields?.["code"] !== undefined} aria-describedby="code-erreur" />
        <FieldError fields={fields} name="code" />
      </label>
      <label>
        Mot de passe (10 caractères au moins)
        <input name="password" type="password" autoComplete="new-password" minLength={10} required aria-invalid={fields?.["password"] !== undefined} aria-describedby="password-erreur" />
        <FieldError fields={fields} name="password" />
      </label>
      <label>
        Confirmation du mot de passe
        <input name="confirmation" type="password" autoComplete="new-password" required aria-invalid={fields?.["confirmation"] !== undefined} aria-describedby="confirmation-erreur" />
        <FieldError fields={fields} name="confirmation" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Création du compte…" : "Créer mon compte"}
      </button>
    </form>
  );
}
