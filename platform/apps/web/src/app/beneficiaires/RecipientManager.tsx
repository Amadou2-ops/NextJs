"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { CORRIDORS, PAYOUT_METHOD_LABELS } from "@/lib/format";
import type { PayoutMethod, Recipient } from "@/lib/types";

import { RecipientForm } from "../envoyer/RecipientForm";
import { archiveRecipientAction } from "./actions";

export function RecipientManager({ recipients }: { readonly recipients: readonly Recipient[] }): React.ReactNode {
  const router = useRouter();
  const [country, setCountry] = useState<string>(CORRIDORS[0].country);
  const [method, setMethod] = useState<PayoutMethod>("mobile_money");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const corridor = CORRIDORS.find((item) => item.country === country) ?? CORRIDORS[0];
  const methods: readonly PayoutMethod[] = corridor.payoutMethods;
  const payoutMethod = methods.includes(method) ? method : (methods[0] ?? "mobile_money");

  const onCreated = useCallback(() => {
    setMessage("Bénéficiaire enregistré.");
    router.refresh();
  }, [router]);

  return (
    <div className="stack">
      {message !== null && (
        <p className="alert success" role="status">
          {message}
        </p>
      )}
      <section className="card">
        {recipients.length === 0 ? (
          <p className="muted">Aucun bénéficiaire enregistré.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Nom</th>
                <th scope="col">Pays</th>
                <th scope="col">Réception</th>
                <th scope="col">Coordonnées</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr key={recipient.id}>
                  <td>
                    {recipient.firstName} {recipient.lastName}
                  </td>
                  <td>{recipient.country}</td>
                  <td>{PAYOUT_METHOD_LABELS[recipient.payoutMethod]}</td>
                  <td>{recipient.displayHint}</td>
                  <td>
                    <button
                      className="secondary"
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`Retirer ${recipient.firstName} ${recipient.lastName} de vos bénéficiaires ?`)) return;
                        startTransition(async () => {
                          const result = await archiveRecipientAction(recipient.id);
                          setMessage(result.status === "error" ? result.message : "Bénéficiaire retiré.");
                        });
                      }}
                    >
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card stack">
        <h2>Ajouter un bénéficiaire</h2>
        <div className="grid">
          <label>
            Pays
            <select value={country} onChange={(event) => setCountry(event.target.value)}>
              {CORRIDORS.map((item) => (
                <option key={item.country} value={item.country}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode de réception
            <select value={payoutMethod} onChange={(event) => setMethod(event.target.value as PayoutMethod)}>
              {methods.map((item) => (
                <option key={item} value={item}>
                  {PAYOUT_METHOD_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <RecipientForm key={`${corridor.country}-${payoutMethod}`} country={corridor.country} currency={corridor.currency} payoutMethod={payoutMethod} onCreated={onCreated} />
      </section>
    </div>
  );
}
