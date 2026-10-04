import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { formatMoney } from "@/lib/format";
import { trustedPaymentUrl } from "@/lib/payment";
import type { FundingAction, TransferDetail } from "@/lib/types";
import { z } from "@/lib/zod";
import { ApiError } from "@/server/api";
import { sessionApi } from "@/server/context";
import { webConfig } from "@/server/env";

import { CardPayment } from "./CardPayment";

export const metadata: Metadata = { title: "Paiement du transfert" };

export default async function PaymentPage({ params }: { readonly params: Promise<{ readonly id: string }> }): Promise<ReactNode> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const path = `/transferts/${id}/paiement`;
  const loaded = await loadPayment(id, path);
  if (loaded === null) notFound();
  const { transfer, funding } = loaded;
  if (funding === null) {
    return (
      <>
        <h1>Paiement</h1>
        <p>
          Ce transfert n&apos;attend plus de paiement. <Link href={`/transferts/${id}`}>Voir le transfert</Link>
        </p>
      </>
    );
  }
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h1>Paiement de {formatMoney(transfer.totalToPay)}</h1>
      <p className="muted">Transfert {transfer.reference}</p>
      <section className="card">
        {funding.type === "stripe_payment_intent" ? (
          <CardPayment publishableKey={funding.publishableKey} clientSecret={funding.clientSecret} returnUrl={`${webConfig().appOrigin}/transferts/${id}?paiement=retour`} />
        ) : trustedPaymentUrl(funding.url) === null ? (
          <p className="alert error">Lien de paiement inattendu : contactez le service client.</p>
        ) : (
          <p>
            Le paiement s&apos;effectue sur la page sécurisée de notre partenaire.{" "}
            <a className="button" href={trustedPaymentUrl(funding.url) ?? undefined} rel="noopener noreferrer">
              Continuer vers le paiement
            </a>
          </p>
        )}
      </section>
    </div>
  );
}

/** Transfert et action de paiement à jour ; null si introuvable, funding null s'il n'attend plus de paiement. */
async function loadPayment(id: string, path: string): Promise<{ readonly transfer: TransferDetail; readonly funding: FundingAction | null } | null> {
  try {
    const transfer = await sessionApi<TransferDetail>(path, { path: `/v1/transfers/${id}` });
    if (transfer.status !== "awaiting_funding") return { transfer, funding: null };
    const { funding } = await sessionApi<{ funding: FundingAction }>(path, { path: `/v1/transfers/${id}/funding` });
    return { transfer, funding };
  } catch (error: unknown) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
}
