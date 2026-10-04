import type { ReactNode } from "react";

/** Valeur saisie à réafficher après une erreur (champs non secrets uniquement). */
export function previous(state: { readonly status: string; readonly values?: Readonly<Record<string, string>> }, name: string): string | undefined {
  return state.status === "error" ? state.values?.[name] : undefined;
}

/** Message global d'un formulaire (annoncé aux lecteurs d'écran). */
export function FormMessage({ state }: { readonly state: { readonly status: string; readonly message?: string } }): ReactNode {
  if (state.status !== "error" || state.message === undefined) return null;
  return (
    <p className="alert error" role="alert">
      {state.message}
    </p>
  );
}

export function FieldError({ fields, name }: { readonly fields: Readonly<Record<string, string>> | undefined; readonly name: string }): ReactNode {
  const message = fields?.[name];
  if (message === undefined) return null;
  return (
    <span className="field-error" id={`${name}-erreur`}>
      {message}
    </span>
  );
}
