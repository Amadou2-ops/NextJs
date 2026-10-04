"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { CORRIDORS, currencyDigits, decimalToMinor, formatDateTime, formatMoney, formatRate, FUNDING_METHOD_LABELS, PAYOUT_METHOD_LABELS, PURPOSE_LABELS } from "@/lib/format";
import type { FundingMethod, PayoutMethod, Quote, Recipient } from "@/lib/types";

import { createTransferAction, quoteAction } from "./actions";
import { RecipientForm } from "./RecipientForm";

type Step = "montant" | "beneficiaire" | "confirmation";

/**
 * Parcours d'envoi en trois étapes : devis garanti, bénéficiaire,
 * confirmation par code TOTP. Le devis affiché est exactement celui qui sera
 * exécuté (identifiant transmis tel quel à l'API).
 */
export function SendFlow(props: { readonly recipients: readonly Recipient[]; readonly sourceCurrencies: readonly string[] }): React.ReactNode {
  const router = useRouter();
  const [step, setStep] = useState<Step>("montant");
  const [destination, setDestination] = useState<string>(CORRIDORS[0].country);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>("mobile_money");
  const [fundingMethod, setFundingMethod] = useState<FundingMethod>("card");
  const [sourceCurrency, setSourceCurrency] = useState<string>(props.sourceCurrencies[0] ?? "EUR");
  const [amount, setAmount] = useState("100");
  const [amountType, setAmountType] = useState<"send" | "receive">("send");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [recipients, setRecipients] = useState<readonly Recipient[]>(props.recipients);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("family_support");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => `web-${crypto.randomUUID()}`);
  const [pending, startTransition] = useTransition();

  const corridor = CORRIDORS.find((item) => item.country === destination) ?? CORRIDORS[0];
  const methods: readonly PayoutMethod[] = corridor.payoutMethods;
  const method = methods.includes(payoutMethod) ? payoutMethod : (methods[0] ?? "mobile_money");
  const amountCurrency = amountType === "send" ? sourceCurrency : corridor.currency;
  const minor = decimalToMinor(amount, currencyDigits(amountCurrency));
  const eligible = recipients.filter((recipient) => recipient.country === corridor.country && recipient.currency === corridor.currency && recipient.payoutMethod === method);

  const requestQuote = (): void => {
    if (minor === null) {
      setError("Saisissez un montant valide.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await quoteAction({
        destinationCountry: corridor.country,
        destinationCurrency: corridor.currency,
        sourceCurrency,
        payoutMethod: method as "mobile_money" | "bank_account" | "cash_pickup",
        fundingMethod: fundingMethod as "card" | "bank_transfer" | "wallet_balance",
        amount: minor,
        amountType,
      });
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "success") {
        setQuote(result.data);
        setIdempotencyKey(`web-${crypto.randomUUID()}`);
        setStep("beneficiaire");
      }
    });
  };

  const onRecipientCreated = useCallback((recipient: Recipient) => {
    setRecipients((current) => [recipient, ...current.filter((item) => item.id !== recipient.id)]);
    setRecipientId(recipient.id);
  }, []);

  const confirm = (): void => {
    const quoteId = quote?.quoteId ?? null;
    if (quoteId === null || recipientId === null) return;
    setError(null);
    startTransition(async () => {
      const result = await createTransferAction({
        quoteId,
        recipientId,
        purposeCode: purpose as "family_support",
        totpCode: totp,
        idempotencyKey,
      });
      if (result.status === "error") {
        setError(result.message);
        if (result.message.includes("devis")) setStep("montant");
        return;
      }
      if (result.status !== "success") return;
      const { transferId, next } = result.data;
      switch (next.kind) {
        case "redirect":
          window.location.assign(next.url);
          return;
        case "card":
          router.push(`/transferts/${transferId}/paiement`);
          return;
        case "detail":
          router.push(`/transferts/${transferId}`);
          return;
      }
    });
  };

  return (
    <div className="stack">
      <ol className="row" aria-label="Étapes">
        <li aria-current={step === "montant" ? "step" : undefined}>1. Montant</li>
        <li aria-current={step === "beneficiaire" ? "step" : undefined}>2. Bénéficiaire</li>
        <li aria-current={step === "confirmation" ? "step" : undefined}>3. Confirmation</li>
      </ol>
      {error !== null && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}

      {step === "montant" && (
        <section className="card stack">
          <div className="grid">
            <label>
              Pays du bénéficiaire
              <select value={destination} onChange={(event) => setDestination(event.target.value)}>
                {CORRIDORS.map((item) => (
                  <option key={item.country} value={item.country}>
                    {item.name} ({item.currency})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode de réception
              <select value={method} onChange={(event) => setPayoutMethod(event.target.value as PayoutMethod)}>
                {methods.map((item) => (
                  <option key={item} value={item}>
                    {PAYOUT_METHOD_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Je paie par
              <select value={fundingMethod} onChange={(event) => setFundingMethod(event.target.value as FundingMethod)}>
                {(["card", "bank_transfer", "wallet_balance"] as const).map((item) => (
                  <option key={item} value={item}>
                    {FUNDING_METHOD_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Devise d&apos;envoi
              <select value={sourceCurrency} onChange={(event) => setSourceCurrency(event.target.value)}>
                {props.sourceCurrencies.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid">
            <label>
              Je saisis
              <select value={amountType} onChange={(event) => setAmountType(event.target.value as "send" | "receive")}>
                <option value="send">le montant envoyé</option>
                <option value="receive">le montant reçu</option>
              </select>
            </label>
            <label>
              Montant ({amountCurrency})
              <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={minor === null} />
            </label>
          </div>
          <button type="button" onClick={requestQuote} disabled={pending || minor === null}>
            {pending ? "Calcul du devis…" : "Obtenir un devis garanti"}
          </button>
        </section>
      )}

      {quote !== null && step !== "montant" && (
        <section className="card">
          <h2>Votre devis</h2>
          <dl className="grid">
            <div>
              <dt className="muted">Montant envoyé</dt>
              <dd className="amount">{formatMoney(quote.sendAmount)}</dd>
            </div>
            <div>
              <dt className="muted">Frais</dt>
              <dd className="amount">{formatMoney(quote.fee)}</dd>
            </div>
            <div>
              <dt className="muted">Total à payer</dt>
              <dd className="amount">{formatMoney(quote.totalToPay)}</dd>
            </div>
            <div>
              <dt className="muted">Le bénéficiaire reçoit</dt>
              <dd className="amount">{formatMoney(quote.receiveAmount)}</dd>
            </div>
            <div>
              <dt className="muted">Taux garanti</dt>
              <dd>{formatRate(quote.exchangeRate, quote.sendAmount.currency, quote.receiveAmount.currency)}</dd>
            </div>
            {quote.expiresAt !== null && (
              <div>
                <dt className="muted">Valable jusqu&apos;au</dt>
                <dd>{formatDateTime(quote.expiresAt)}</dd>
              </div>
            )}
          </dl>
          <button className="secondary" type="button" onClick={() => setStep("montant")}>
            Modifier le montant
          </button>
        </section>
      )}

      {step === "beneficiaire" && (
        <section className="card stack">
          <h2>À qui envoyez-vous ?</h2>
          {eligible.length > 0 && (
            <fieldset className="stack">
              <legend className="muted">Bénéficiaires enregistrés</legend>
              {eligible.map((recipient) => (
                <label key={recipient.id} style={{ flexDirection: "row", alignItems: "center", fontWeight: 400 }}>
                  <input type="radio" name="recipient" value={recipient.id} checked={recipientId === recipient.id} onChange={() => setRecipientId(recipient.id)} />
                  {recipient.firstName} {recipient.lastName} — {recipient.displayHint}
                </label>
              ))}
            </fieldset>
          )}
          <details open={eligible.length === 0}>
            <summary>Ajouter un bénéficiaire</summary>
            <RecipientForm country={corridor.country} currency={corridor.currency} payoutMethod={method} onCreated={onRecipientCreated} />
          </details>
          <button type="button" disabled={recipientId === null} onClick={() => setStep("confirmation")}>
            Continuer
          </button>
        </section>
      )}

      {step === "confirmation" && (
        <section className="card stack">
          <h2>Confirmation</h2>
          <label>
            Motif du transfert
            <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
              {Object.entries(PURPOSE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Code de votre application d&apos;authentification
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} />
          </label>
          <p className="muted">
            Pas encore d&apos;application d&apos;authentification ? Activez-la dans <Link href="/securite">Sécurité</Link> : elle est exigée pour confirmer un
            transfert depuis le site.
          </p>
          <button type="button" onClick={confirm} disabled={pending || totp.length !== 6}>
            {pending ? "Envoi…" : `Confirmer et payer ${quote === null ? "" : formatMoney(quote.totalToPay)}`}
          </button>
          <button className="secondary" type="button" onClick={() => setStep("beneficiaire")}>
            Retour
          </button>
        </section>
      )}
    </div>
  );
}
