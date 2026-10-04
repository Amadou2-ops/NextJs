"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState, useTransition } from "react";
import type { ReactNode } from "react";

import type { LoginState } from "./actions";
import { abandonLoginAction, completeLoginAction, startLoginAction } from "./actions";

type Step = "credentials" | "security-key";

/**
 * Mot de passe d'abord (vérifié par l'API), puis la clé de sécurité est
 * sollicitée dans la foulée ; en cas d'échec, tout recommence.
 */
export function LoginForm({ suite }: { readonly suite: string | null }): ReactNode {
  const [state, setState] = useState<LoginState>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("credentials");
  const [pending, startTransition] = useTransition();
  const fields = state.status === "error" ? state.fields : undefined;
  const previousEmail = state.status === "error" ? state.values?.["email"] : undefined;

  const submit = (form: FormData): void => {
    setError(null);
    startTransition(async () => {
      const result = await startLoginAction({ status: "idle" }, form);
      setState(result);
      if (result.status !== "success") return;
      setStep("security-key");
      let response;
      try {
        response = await startAuthentication({ optionsJSON: result.data.options });
      } catch {
        await abandonLoginAction();
        setStep("credentials");
        setError("La clé de sécurité n'a pas été utilisée (annulée ou non reconnue). Recommencez.");
        return;
      }
      const outcome = await completeLoginAction(response);
      setStep("credentials");
      setError(outcome.error);
    });
  };

  return (
    <form action={submit} className="card stack narrow" noValidate>
      {state.status === "error" && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      {error !== null && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {step === "security-key" && (
        <p className="alert info" role="status">
          Touchez votre clé de sécurité pour terminer la connexion…
        </p>
      )}
      {suite !== null && <input type="hidden" name="suite" value={suite} />}
      <label>
        Adresse e-mail professionnelle
        <input name="email" type="email" autoComplete="username" defaultValue={previousEmail} required aria-invalid={fields?.["email"] !== undefined} />
        {fields?.["email"] !== undefined && <span className="field-error">{fields["email"]}</span>}
      </label>
      <label>
        Mot de passe
        <input name="password" type="password" autoComplete="current-password" required aria-invalid={fields?.["password"] !== undefined} />
        {fields?.["password"] !== undefined && <span className="field-error">{fields["password"]}</span>}
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Vérification…" : "Continuer avec ma clé de sécurité"}
      </button>
    </form>
  );
}
