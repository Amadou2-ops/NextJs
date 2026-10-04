"use client";

import { useActionState } from "react";

import { FieldError, FormMessage, previous } from "@/components/FormStatus";
import { SENDING_COUNTRIES } from "@/lib/format";
import type { ActionState } from "@/server/actionState";

import { startRegistrationAction } from "./actions";

export function RegistrationForm(): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(startRegistrationAction, { status: "idle" });
  const fields = state.status === "error" ? state.fields : undefined;
  return (
    <form action={action} className="card stack" noValidate>
      <FormMessage state={state} />
      <label>
        Pays de résidence
        <select name="countryOfResidence" defaultValue={previous(state, "countryOfResidence") ?? "FR"} aria-invalid={fields?.["countryOfResidence"] !== undefined}>
          {SENDING_COUNTRIES.map((item) => (
            <option key={item.country} value={item.country}>
              {item.name}
            </option>
          ))}
        </select>
        <FieldError fields={fields} name="countryOfResidence" />
      </label>
      <label>
        Numéro de téléphone mobile
        <input name="phone" defaultValue={previous(state, "phone")} type="tel" autoComplete="tel" placeholder="+33 6 12 34 56 78" required aria-invalid={fields?.["phone"] !== undefined} aria-describedby="phone-erreur" />
        <FieldError fields={fields} name="phone" />
      </label>
      <label style={{ flexDirection: "row", alignItems: "flex-start", fontWeight: 400 }}>
        <input type="checkbox" name="consent" value="oui" required defaultChecked={previous(state, "consent") === "oui"} />
        <span>J&apos;accepte les conditions générales d&apos;utilisation et la politique de confidentialité.</span>
      </label>
      <FieldError fields={fields} name="consent" />
      <button type="submit" disabled={pending}>
        {pending ? "Envoi du code…" : "Recevoir un code par SMS"}
      </button>
    </form>
  );
}
