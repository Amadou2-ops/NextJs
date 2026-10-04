"use client";

import { useActionState, useEffect } from "react";

import { FieldError, FormMessage, previous } from "@/components/FormStatus";
import { PAYOUT_METHOD_LABELS, operatorsForCountry } from "@/lib/format";
import type { PayoutMethod, Recipient } from "@/lib/types";
import type { ActionState } from "@/server/actionState";

import { createRecipientAction } from "./actions";

export function RecipientForm(props: {
  readonly country: string;
  readonly currency: string;
  readonly payoutMethod: PayoutMethod;
  readonly onCreated: (recipient: Recipient) => void;
}): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState<Recipient>, FormData>(createRecipientAction, { status: "idle" });
  const kind = props.payoutMethod;
  const fields = state.status === "error" ? state.fields : undefined;
  const { onCreated } = props;

  useEffect(() => {
    if (state.status === "success") onCreated(state.data);
  }, [state, onCreated]);

  return (
    <form action={action} className="stack" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="country" value={props.country} />
      <input type="hidden" name="currency" value={props.currency} />
      <input type="hidden" name="kind" value={kind} />
      <p className="muted">Réception : {PAYOUT_METHOD_LABELS[kind]}</p>
      <div className="grid">
        <label>
          Prénom(s)
          <input name="firstName" defaultValue={previous(state, "firstName")} autoComplete="off" required aria-invalid={fields?.["firstName"] !== undefined} />
          <FieldError fields={fields} name="firstName" />
        </label>
        <label>
          Nom
          <input name="lastName" defaultValue={previous(state, "lastName")} autoComplete="off" required aria-invalid={fields?.["lastName"] !== undefined} />
          <FieldError fields={fields} name="lastName" />
        </label>
        <label>
          Lien
          <select name="relationship" defaultValue={previous(state, "relationship") ?? "family"}>
            <option value="family">Famille</option>
            <option value="friend">Ami(e)</option>
            <option value="self">Moi-même</option>
            <option value="business">Professionnel</option>
            <option value="other">Autre</option>
          </select>
        </label>
      </div>
      {(kind === "mobile_money" || kind === "cash_pickup") && (
        <div className="grid">
          <label>
            Numéro de téléphone du bénéficiaire
            <input name="msisdn" defaultValue={previous(state, "msisdn")} type="tel" autoComplete="off" required aria-invalid={fields?.["msisdn"] !== undefined} />
            <FieldError fields={fields} name="msisdn" />
          </label>
          {kind === "mobile_money" && (
            <label>
              Opérateur
              <select name="operator" defaultValue={previous(state, "operator")} aria-invalid={fields?.["operator"] !== undefined}>
                {operatorsForCountry(props.country).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldError fields={fields} name="operator" />
            </label>
          )}
        </div>
      )}
      {kind === "bank_account" && (
        <div className="grid">
          <label>
            IBAN
            <input name="iban" defaultValue={previous(state, "iban")} autoComplete="off" aria-invalid={fields?.["iban"] !== undefined} />
            <FieldError fields={fields} name="iban" />
          </label>
          <label>
            ou numéro de compte
            <input name="accountNumber" defaultValue={previous(state, "accountNumber")} autoComplete="off" />
          </label>
          <label>
            Code banque
            <input name="bankCode" defaultValue={previous(state, "bankCode")} autoComplete="off" />
          </label>
        </div>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Enregistrement…" : "Enregistrer le bénéficiaire"}
      </button>
    </form>
  );
}
