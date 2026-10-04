"use client";

import { useActionState, useState } from "react";
import type { ReactNode } from "react";

import type { AdminActionState } from "@/server/actionState";

import { requestAdjustmentAction } from "../actions";

/** Lignes contrôlées : conservées après une erreur (React réinitialise les champs non contrôlés). */
interface Line {
  readonly key: number;
  readonly accountId: string;
  readonly direction: "debit" | "credit";
  readonly amount: string;
  readonly currency: string;
}

const MAX_LINES = 20;

/** Saisie ligne à ligne ; la conversion en unités mineures et l'équilibre sont vérifiés côté serveur. */
export function AdjustmentForm({ currencies }: { readonly currencies: readonly string[] }): ReactNode {
  const [state, dispatch, pending] = useActionState<AdminActionState, FormData>(requestAdjustmentAction, { status: "idle" });
  const blank = (key: number, direction: Line["direction"]): Line => ({ key, accountId: "", direction, amount: "", currency: currencies[0] ?? "EUR" });
  const [lines, setLines] = useState<readonly Line[]>(() => [blank(0, "debit"), blank(1, "credit")]);
  const [nextKey, setNextKey] = useState(2);
  const fields = state.status === "error" ? state.fields : {};
  const previous = state.status === "error" ? state.values : undefined;

  const addLine = (): void => {
    if (lines.length >= MAX_LINES) return;
    setLines([...lines, blank(nextKey, lines.length % 2 === 0 ? "debit" : "credit")]);
    setNextKey(nextKey + 1);
  };
  const update = (key: number, change: Partial<Omit<Line, "key">>): void => {
    setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));
  };
  const removeLine = (key: number): void => {
    if (lines.length > 2) setLines(lines.filter((line) => line.key !== key));
  };

  return (
    <form action={dispatch} className="card stack">
      {state.status === "error" && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <p className="alert success" role="status">
          {state.data.message}
        </p>
      )}
      <label>
        Libellé de l&apos;écriture
        <input name="description" minLength={10} maxLength={500} required defaultValue={previous?.["description"]} aria-invalid={fields["description"] !== undefined} />
        {fields["description"] !== undefined && <span className="field-error">{fields["description"]}</span>}
      </label>
      <table>
        <thead>
          <tr>
            <th>Compte (identifiant)</th>
            <th>Sens</th>
            <th>Montant</th>
            <th>Devise</th>
            <th>
              <span className="sr-only">Retirer</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.key}>
              <td>
                <input name="accountId" required maxLength={36} autoComplete="off" value={line.accountId} onChange={(event) => update(line.key, { accountId: event.target.value })} aria-label={`Compte, ligne ${(index + 1).toString()}`} />
              </td>
              <td>
                <select name="direction" aria-label={`Sens, ligne ${(index + 1).toString()}`} value={line.direction} onChange={(event) => update(line.key, { direction: event.target.value === "credit" ? "credit" : "debit" })}>
                  <option value="debit">Débit</option>
                  <option value="credit">Crédit</option>
                </select>
              </td>
              <td>
                <input name="amount" required inputMode="decimal" maxLength={30} autoComplete="off" value={line.amount} onChange={(event) => update(line.key, { amount: event.target.value })} aria-label={`Montant, ligne ${(index + 1).toString()}`} />
              </td>
              <td>
                <select name="currency" aria-label={`Devise, ligne ${(index + 1).toString()}`} value={line.currency} onChange={(event) => update(line.key, { currency: event.target.value })}>
                  {currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button type="button" className="secondary small-button" onClick={() => removeLine(line.key)} disabled={lines.length <= 2}>
                  Retirer
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(fields["accountId"] ?? fields["amount"] ?? fields["currency"]) !== undefined && <span className="field-error">{fields["accountId"] ?? fields["amount"] ?? fields["currency"]}</span>}
      <div className="row">
        <button type="button" className="secondary" onClick={addLine} disabled={lines.length >= MAX_LINES}>
          Ajouter une ligne
        </button>
      </div>
      <label>
        Justification
        <textarea name="justification" minLength={10} maxLength={1000} rows={3} required defaultValue={previous?.["justification"]} aria-invalid={fields["justification"] !== undefined} />
        {fields["justification"] !== undefined && <span className="field-error">{fields["justification"]}</span>}
      </label>
      <p className="badge four-eyes">Double validation : aucune écriture avant l&apos;approbation d&apos;un second membre.</p>
      <button type="submit" disabled={pending}>
        {pending ? "Envoi…" : "Créer la demande d'ajustement"}
      </button>
    </form>
  );
}
