"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { CORRIDORS, currencyDigits, decimalToMinor, formatMoney, formatRate, PAYOUT_METHOD_LABELS, SENDING_COUNTRIES } from "@/lib/format";
import type { PayoutMethod, Quote } from "@/lib/types";

type Estimate = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ok"; readonly quote: Quote } | { readonly kind: "error"; readonly message: string };

/** Calculateur public : simulation au taux du moment, sans engagement. */
export function Calculator(): React.ReactNode {
  const id = useId();
  const [origin, setOrigin] = useState<string>(SENDING_COUNTRIES[0].country);
  const [destination, setDestination] = useState<string>(CORRIDORS[0].country);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>("mobile_money");
  const [amount, setAmount] = useState("100");
  const [estimate, setEstimate] = useState<Estimate>({ kind: "idle" });

  const sender = SENDING_COUNTRIES.find((item) => item.country === origin) ?? SENDING_COUNTRIES[0];
  const corridor = CORRIDORS.find((item) => item.country === destination) ?? CORRIDORS[0];
  const methods: readonly PayoutMethod[] = corridor.payoutMethods;
  const method = methods.includes(payoutMethod) ? payoutMethod : (methods[0] ?? "mobile_money");
  const minor = decimalToMinor(amount, currencyDigits(sender.currency));

  useEffect(() => {
    if (minor === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setEstimate({ kind: "loading" });
      const params = new URLSearchParams({
        sourceCountry: sender.country,
        destinationCountry: corridor.country,
        sourceCurrency: sender.currency,
        destinationCurrency: corridor.currency,
        payoutMethod: method,
        amount: minor,
      });
      fetch(`/api/estimation?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json()) as Quote | { readonly message: string };
          if (!response.ok || !("sendAmount" in body)) {
            setEstimate({ kind: "error", message: "message" in body ? body.message : "Simulation indisponible." });
            return;
          }
          setEstimate({ kind: "ok", quote: body });
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setEstimate({ kind: "error", message: "Simulation indisponible." });
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sender.country, sender.currency, corridor.country, corridor.currency, method, minor]);

  return (
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Combien recevront vos proches ?</h2>
      <div className="grid">
        <label>
          Depuis
          <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
            {SENDING_COUNTRIES.map((item) => (
              <option key={item.country} value={item.country}>
                {item.name} ({item.currency})
              </option>
            ))}
          </select>
        </label>
        <label>
          Vers
          <select value={destination} onChange={(event) => setDestination(event.target.value)}>
            {CORRIDORS.map((item) => (
              <option key={item.country} value={item.country}>
                {item.name} ({item.currency})
              </option>
            ))}
          </select>
        </label>
        <label>
          Réception
          <select value={method} onChange={(event) => setPayoutMethod(event.target.value as PayoutMethod)}>
            {methods.map((item) => (
              <option key={item} value={item}>
                {PAYOUT_METHOD_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vous envoyez ({sender.currency})
          <input inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={minor === null} />
        </label>
      </div>
      <div aria-live="polite">
        {minor === null && <p className="field-error">Saisissez un montant valide.</p>}
        {estimate.kind === "loading" && <p className="muted">Calcul en cours…</p>}
        {estimate.kind === "error" && <p className="field-error">{estimate.message}</p>}
        {estimate.kind === "ok" && (
          <dl className="grid">
            <div>
              <dt className="muted">Le bénéficiaire reçoit</dt>
              <dd className="amount">{formatMoney(estimate.quote.receiveAmount)}</dd>
            </div>
            <div>
              <dt className="muted">Frais</dt>
              <dd className="amount">{formatMoney(estimate.quote.fee)}</dd>
            </div>
            <div>
              <dt className="muted">Total à payer</dt>
              <dd className="amount">{formatMoney(estimate.quote.totalToPay)}</dd>
            </div>
            <div>
              <dt className="muted">Taux</dt>
              <dd>{formatRate(estimate.quote.exchangeRate, sender.currency, corridor.currency)}</dd>
            </div>
          </dl>
        )}
      </div>
      <p className="muted">Simulation indicative : le taux et les frais sont garantis au moment du devis, avant votre confirmation.</p>
      <Link className="button" href="/inscription">
        Commencer
      </Link>
    </section>
  );
}
