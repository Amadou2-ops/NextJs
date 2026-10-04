"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";

/**
 * Paiement par carte (Stripe Payment Element). Les données de carte sont
 * saisies dans les iframes de Stripe : elles ne transitent jamais par nos
 * serveurs. La confirmation 3-D Secure est gérée par Stripe ; l'état final
 * est confirmé côté API par webhook signé et relecture du paiement.
 */

function PaymentForm({ returnUrl }: { readonly returnUrl: string }): React.ReactNode {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    if (stripe === null || elements === null) return;
    setPending(true);
    setError(null);
    const result = await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } });
    // En cas de succès, Stripe redirige vers returnUrl ; on n'arrive ici qu'en cas d'erreur.
    setError(result.error.message ?? "Le paiement a été refusé.");
    setPending(false);
  };

  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <PaymentElement options={{ layout: "tabs" }} />
      <button type="submit" disabled={pending || stripe === null}>
        {pending ? "Paiement en cours…" : "Payer"}
      </button>
    </form>
  );
}

export function CardPayment(props: { readonly publishableKey: string; readonly clientSecret: string; readonly returnUrl: string }): React.ReactNode {
  const stripePromise = useMemo<Promise<Stripe | null>>(() => loadStripe(props.publishableKey), [props.publishableKey]);
  return (
    <Elements stripe={stripePromise} options={{ clientSecret: props.clientSecret, locale: "fr" }}>
      <PaymentForm returnUrl={props.returnUrl} />
    </Elements>
  );
}
