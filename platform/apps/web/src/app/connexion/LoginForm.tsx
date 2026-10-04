"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useActionState, useState, useTransition } from "react";

import { FieldError, FormMessage, previous } from "@/components/FormStatus";
import type { ActionState } from "@/server/actionState";

import { loginAction, passkeyOptionsAction, passkeyVerifyAction } from "./actions";

export function LoginForm({ suite }: { readonly suite: string | null }): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(loginAction, { status: "idle" });
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyPending, startPasskey] = useTransition();
  const fields = state.status === "error" ? state.fields : undefined;

  const signInWithPasskey = (): void => {
    setPasskeyError(null);
    startPasskey(async () => {
      const options = await passkeyOptionsAction();
      if ("error" in options) {
        setPasskeyError(options.error);
        return;
      }
      try {
        const response = await startAuthentication({ optionsJSON: options.options });
        const result = await passkeyVerifyAction(options.challengeId, response, suite);
        setPasskeyError(result.error);
      } catch {
        setPasskeyError("La passkey n'a pas pu être utilisée sur cet appareil.");
      }
    });
  };

  return (
    <div className="stack">
      <form action={action} className="card stack" noValidate>
        <FormMessage state={state} />
        {suite !== null && <input type="hidden" name="suite" value={suite} />}
        <label>
          Numéro de téléphone
          <input name="phone" defaultValue={previous(state, "phone")} type="tel" autoComplete="tel" required aria-invalid={fields?.["phone"] !== undefined} aria-describedby="phone-erreur" />
          <FieldError fields={fields} name="phone" />
        </label>
        <label>
          Mot de passe
          <input name="password" type="password" autoComplete="current-password" required aria-invalid={fields?.["password"] !== undefined} aria-describedby="password-erreur" />
          <FieldError fields={fields} name="password" />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Connexion…" : "Se connecter"}
        </button>
      </form>
      <div className="card stack">
        <p className="muted">Vous avez enregistré une passkey sur cet appareil ?</p>
        {passkeyError !== null && (
          <p className="alert error" role="alert">
            {passkeyError}
          </p>
        )}
        <button className="secondary" type="button" onClick={signInWithPasskey} disabled={passkeyPending}>
          {passkeyPending ? "Vérification…" : "Se connecter avec une passkey"}
        </button>
      </div>
    </div>
  );
}
