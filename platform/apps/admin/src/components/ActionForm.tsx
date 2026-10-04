"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId } from "react";
import type { ReactNode } from "react";

import type { AdminActionState } from "@/server/actionState";

/**
 * Formulaire d'action du personnel (motif, justification, décision…). Les
 * champs sont décrits par le composant serveur ; la validation fait foi côté
 * serveur. Une valeur sensible renvoyée (lien d'enrôlement) est affichée une
 * seule fois et n'est jamais conservée.
 */

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "textarea" | "select" | "checkboxes" | "datetime";
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly help?: string;
  /** Valeur initiale (modification d'un paramétrage existant). */
  readonly defaultValue?: string;
}

interface ActionFormProps {
  readonly action: (state: AdminActionState, form: FormData) => Promise<AdminActionState>;
  readonly title: string;
  readonly description?: string | undefined;
  readonly fields: readonly FieldSpec[];
  readonly submitLabel: string;
  readonly tone?: "primary" | "danger";
  /** Case à cocher de confirmation explicite (actions irréversibles). */
  readonly confirmation?: string;
  readonly fourEyes?: boolean;
}

function Field({ field, state, formId }: { readonly field: FieldSpec; readonly state: AdminActionState; readonly formId: string }): ReactNode {
  const id = `${formId}-${field.name}`;
  const error = state.status === "error" ? state.fields[field.name] : undefined;
  const previous = state.status === "error" ? state.values?.[field.name] : field.defaultValue;
  const described = error === undefined ? undefined : `${id}-erreur`;
  let control: ReactNode;
  switch (field.kind) {
    case "textarea":
      control = (
        <textarea
          id={id}
          name={field.name}
          defaultValue={previous}
          required={field.required ?? true}
          minLength={field.minLength}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          rows={3}
          aria-invalid={error !== undefined}
          aria-describedby={described}
        />
      );
      break;
    case "select":
      control = (
        <select id={id} name={field.name} defaultValue={previous} required={field.required ?? true} aria-invalid={error !== undefined} aria-describedby={described}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case "checkboxes":
      return (
        <fieldset aria-describedby={described}>
          <legend>{field.label}</legend>
          {(field.options ?? []).map((option) => (
            <label key={option.value} className="inline">
              <input type="checkbox" name={field.name} value={option.value} />
              {option.label}
            </label>
          ))}
          {error !== undefined && (
            <span className="field-error" id={described}>
              {error}
            </span>
          )}
        </fieldset>
      );
    case "datetime":
      control = (
        <input
          id={id}
          name={field.name}
          type="datetime-local"
          defaultValue={previous}
          required={field.required ?? true}
          aria-invalid={error !== undefined}
          aria-describedby={described}
        />
      );
      break;
    case "text":
      control = (
        <input
          id={id}
          name={field.name}
          defaultValue={previous}
          required={field.required ?? true}
          minLength={field.minLength}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          autoComplete="off"
          aria-invalid={error !== undefined}
          aria-describedby={described}
        />
      );
      break;
  }
  return (
    <label htmlFor={id}>
      {field.label}
      {control}
      {field.help !== undefined && <span className="muted small">{field.help}</span>}
      {error !== undefined && (
        <span className="field-error" id={described}>
          {error}
        </span>
      )}
    </label>
  );
}

export function ActionForm({ action, title, description, fields, submitLabel, tone = "primary", confirmation, fourEyes = false }: ActionFormProps): ReactNode {
  const [state, dispatch, pending] = useActionState<AdminActionState, FormData>(action, { status: "idle" });
  const formId = useId();
  const router = useRouter();
  return (
    <form action={dispatch} className="card stack action-form">
      <h3>{title}</h3>
      {description !== undefined && <p className="muted">{description}</p>}
      {fourEyes && <p className="badge four-eyes">Double validation : un second membre habilité devra approuver.</p>}
      {state.status === "error" && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <div className="alert success" role="status">
          <p>{state.data.message}</p>
          {state.data.secret !== undefined && (
            <p>
              <strong>{state.data.secret.label}</strong>
              <br />
              <code className="secret">{state.data.secret.value}</code>
              <br />
              <span className="small">Transmettez-le par un canal sûr : il ne sera plus jamais affiché.</span>
              <br />
              <button type="button" className="secondary small-button" onClick={() => router.refresh()}>
                J&apos;ai transmis le lien : actualiser la page
              </button>
            </p>
          )}
        </div>
      )}
      {fields.map((field) => (
        <Field key={field.name} field={field} state={state} formId={formId} />
      ))}
      {confirmation !== undefined && (
        <label className="inline">
          <input type="checkbox" name="confirm" value="yes" required />
          {confirmation}
        </label>
      )}
      <button type="submit" className={tone === "danger" ? "danger" : undefined} disabled={pending}>
        {pending ? "Envoi…" : submitLabel}
      </button>
    </form>
  );
}
