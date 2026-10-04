import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Details, Mono } from "@/components/ui";
import type { QuotePreview } from "@/lib/configuration";
import { amountToMinor, formatBps, FUNDING_METHOD_LABELS, FUNDING_METHODS, PAYOUT_METHOD_LABELS, PAYOUT_METHODS } from "@/lib/configuration";
import { userMessage } from "@/lib/errors";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { SearchParams } from "@/lib/url";
import { oneOf, single } from "@/lib/url";
import { ApiError } from "@/server/api";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Aperçu du prix client" };

interface Inputs {
  readonly sourceCountry: string;
  readonly destinationCountry: string;
  readonly sourceCurrency: string;
  readonly destinationCurrency: string;
  readonly payoutMethod: (typeof PAYOUT_METHODS)[number];
  readonly fundingMethod: (typeof FUNDING_METHODS)[number];
  readonly amount: string;
}

/** Lecture stricte des paramètres de l'URL (formulaire GET : aucune écriture). */
function readInputs(params: Record<string, string | string[] | undefined>): { readonly values: { readonly [K in keyof Inputs]: Inputs[K] | undefined }; readonly complete: Inputs | null } {
  const upper = (key: string, length: number): string | undefined => {
    const value = single(params[key])?.trim().toUpperCase();
    return value !== undefined && new RegExp(`^[A-Z]{${length.toString()}}$`).test(value) ? value : undefined;
  };
  const values = {
    sourceCountry: upper("sourceCountry", 2),
    destinationCountry: upper("destinationCountry", 2),
    sourceCurrency: upper("sourceCurrency", 3),
    destinationCurrency: upper("destinationCurrency", 3),
    payoutMethod: oneOf(single(params["payoutMethod"]), PAYOUT_METHODS),
    fundingMethod: oneOf(single(params["fundingMethod"]), FUNDING_METHODS),
    amount: single(params["amount"])?.slice(0, 20),
  };
  const { sourceCountry, destinationCountry, sourceCurrency, destinationCurrency, payoutMethod, fundingMethod, amount } = values;
  const complete =
    sourceCountry !== undefined && destinationCountry !== undefined && sourceCurrency !== undefined && destinationCurrency !== undefined && payoutMethod !== undefined && fundingMethod !== undefined && amount !== undefined
      ? { sourceCountry, destinationCountry, sourceCurrency, destinationCurrency, payoutMethod, fundingMethod, amount }
      : null;
  return { values, complete };
}

export default async function QuotePreviewPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const { values, complete } = readInputs(await searchParams);
  let preview: QuotePreview | null = null;
  let error: string | null = null;
  if (complete !== null) {
    const minor = amountToMinor(complete.amount, complete.sourceCurrency, false);
    if (minor === null) {
      error = "Montant invalide pour cette devise.";
    } else {
      try {
        preview = await sessionApi<QuotePreview>("/parametrage/apercu", {
          method: "POST",
          path: "/v1/admin/configuration/quote-preview",
          body: { ...complete, amount: minor, amountType: "send" },
        });
      } catch (caught: unknown) {
        if (!(caught instanceof ApiError)) throw caught;
        error = userMessage(caught.code, caught.detail);
      }
    }
  }

  return (
    <>
      <h1>Aperçu du prix client</h1>
      <p className="muted">Prix qu&apos;obtiendrait un client à cet instant, avec les règles réellement appliquées. Aucun devis n&apos;est enregistré.</p>
      <form method="get" className="card stack">
        <div className="grid">
          <label>
            Pays d&apos;envoi
            <input name="sourceCountry" defaultValue={values.sourceCountry ?? "FR"} maxLength={2} required />
          </label>
          <label>
            Pays de destination
            <input name="destinationCountry" defaultValue={values.destinationCountry ?? "SN"} maxLength={2} required />
          </label>
          <label>
            Devise d&apos;envoi
            <input name="sourceCurrency" defaultValue={values.sourceCurrency ?? "EUR"} maxLength={3} required />
          </label>
          <label>
            Devise reçue
            <input name="destinationCurrency" defaultValue={values.destinationCurrency ?? "XOF"} maxLength={3} required />
          </label>
          <label>
            Mode de réception
            <select name="payoutMethod" defaultValue={values.payoutMethod ?? "mobile_money"}>
              {PAYOUT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {PAYOUT_METHOD_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Moyen de paiement
            <select name="fundingMethod" defaultValue={values.fundingMethod ?? "card"}>
              {FUNDING_METHODS.map((value) => (
                <option key={value} value={value}>
                  {FUNDING_METHOD_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Montant envoyé
            <input name="amount" defaultValue={values.amount ?? "100"} maxLength={20} required />
          </label>
        </div>
        <button type="submit">Calculer</button>
      </form>
      {error !== null && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {preview !== null && (
        <section className="card" aria-label="Résultat">
          <Details
            items={[
              ["Montant envoyé", formatMoney(preview.sendAmount.amount, preview.sendAmount.currency)],
              ["Frais", formatMoney(preview.fee.amount, preview.fee.currency)],
              ["Total payé", formatMoney(preview.totalToPay.amount, preview.totalToPay.currency)],
              ["Montant reçu", formatMoney(preview.receiveAmount.amount, preview.receiveAmount.currency)],
              ["Taux moyen", <Mono key="m">{preview.midRate}</Mono>],
              ["Taux client", <Mono key="c">{preview.customerRate}</Mono>],
              ["Marge appliquée", formatBps(preview.marginBps)],
              ["Marge (règle)", preview.pricingRuleId === null ? "Aucune (même devise)" : <Mono key="r">{preview.pricingRuleId}</Mono>],
              ["Barème de frais", <Mono key="f">{preview.feeScheduleId}</Mono>],
              ["Délai annoncé", `${preview.estimatedDeliveryMinutes.toString()} min`],
              ["Horodatage du taux", formatDateTime(preview.rateTimestamp)],
            ]}
          />
        </section>
      )}
    </>
  );
}
