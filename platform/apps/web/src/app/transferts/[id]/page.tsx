import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { formatDateTime, formatMoney, formatRate, FUNDING_METHOD_LABELS, PAYOUT_METHOD_LABELS, PURPOSE_LABELS, TRANSFER_STATUS_LABELS } from "@/lib/format";
import type { TransferDetail } from "@/lib/types";
import { z } from "@/lib/zod";
import { ApiError } from "@/server/api";
import { sessionApi } from "@/server/context";

import { CancelButton } from "./CancelButton";

export const metadata: Metadata = { title: "Détail du transfert" };

const CANCELLABLE = new Set(["created", "awaiting_funding", "funded", "payout_pending"]);

export default async function TransferPage({ params }: { readonly params: Promise<{ readonly id: string }> }): Promise<ReactNode> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  let transfer: TransferDetail;
  try {
    transfer = await sessionApi<TransferDetail>(`/transferts/${id}`, { path: `/v1/transfers/${id}` });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <>
      <h1>Transfert {transfer.reference}</h1>
      <div className="grid">
        <section className="card">
          <h2>Statut</h2>
          <p>
            <span className={`badge ${transfer.status}`}>{TRANSFER_STATUS_LABELS[transfer.status]}</span>
          </p>
          {transfer.status === "awaiting_funding" && transfer.fundingMethod === "card" && (
            <Link className="button" href={`/transferts/${transfer.id}/paiement`}>
              Payer maintenant
            </Link>
          )}
          {transfer.status === "compliance_review" && <p className="muted">Une vérification réglementaire est en cours. Elle prend en général moins de 24 heures.</p>}
          {CANCELLABLE.has(transfer.status) && <CancelButton transferId={transfer.id} />}
          <ol className="timeline">
            {transfer.history.map((event) => (
              <li key={`${event.status}-${event.at}`}>
                <strong>{TRANSFER_STATUS_LABELS[event.status]}</strong>
                <br />
                <span className="muted">{formatDateTime(event.at)}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="card">
          <h2>Montants</h2>
          <dl>
            <dt className="muted">Montant envoyé</dt>
            <dd className="amount">{formatMoney(transfer.sendAmount)}</dd>
            <dt className="muted">Frais</dt>
            <dd className="amount">{formatMoney(transfer.fee)}</dd>
            <dt className="muted">Total payé</dt>
            <dd className="amount">{formatMoney(transfer.totalToPay)}</dd>
            <dt className="muted">Le bénéficiaire reçoit</dt>
            <dd className="amount">{formatMoney(transfer.receiveAmount)}</dd>
            <dt className="muted">Taux</dt>
            <dd>{formatRate(transfer.exchangeRate, transfer.sendAmount.currency, transfer.receiveAmount.currency)}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Détails</h2>
          <dl>
            <dt className="muted">Bénéficiaire</dt>
            <dd>{transfer.recipient.displayHint}</dd>
            <dt className="muted">Réception</dt>
            <dd>{PAYOUT_METHOD_LABELS[transfer.payoutMethod]}</dd>
            <dt className="muted">Paiement</dt>
            <dd>{FUNDING_METHOD_LABELS[transfer.fundingMethod]}</dd>
            <dt className="muted">Motif</dt>
            <dd>{PURPOSE_LABELS[transfer.purposeCode] ?? transfer.purposeCode}</dd>
            <dt className="muted">Créé le</dt>
            <dd>{formatDateTime(transfer.createdAt)}</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
