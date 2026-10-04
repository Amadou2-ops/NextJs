import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, Json, NoAccess } from "@/components/ui";
import { ALERT_STATUS_LABELS, formatDateTime, formatMoney, label, SEVERITY_LABELS, TRANSFER_STATUS_LABELS } from "@/lib/format";
import type { TransferDetail, TransferStatus } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { holdTransferAction, releaseTransferAction, requestRefundAction } from "../actions";

export const metadata: Metadata = { title: "Transfert" };

const DIRECTION_LABELS: Readonly<Record<string, string>> = { payin: "Encaissement", payout: "Versement", refund: "Remboursement" };

/** États où le paiement n'est pas encore engagé vers le bénéficiaire (mise en revue possible). */
const HOLDABLE: readonly TransferStatus[] = ["funded", "payout_pending"];
/** États où un remboursement peut être ordonné. */
const REFUNDABLE: readonly TransferStatus[] = ["funded", "payout_pending", "compliance_review", "payout_failed"];

export default async function TransferPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "transfers:read")) return <NoAccess permission="transfers:read" />;
  const transfer = await sessionApi<TransferDetail>(`/transferts/${id}`, { path: `/v1/admin/transfers/${id}` });

  return (
    <>
      <h1>
        Transfert {transfer.reference} <Badge value={transfer.status} labels={TRANSFER_STATUS_LABELS} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Client", can(admin, "customers:read") ? <Link key="c" href={`/clients/${transfer.userId}`}>{transfer.userId}</Link> : transfer.userId],
            ["Corridor", `${transfer.corridor.from} → ${transfer.corridor.to}`],
            ["Montant envoyé", formatMoney(transfer.send.amountMinor, transfer.send.currency)],
            ["Frais", formatMoney(transfer.fee.amountMinor, transfer.fee.currency)],
            ["Total débité", formatMoney(transfer.totalDebit.amountMinor, transfer.totalDebit.currency)],
            ["Montant reçu", formatMoney(transfer.receive.amountMinor, transfer.receive.currency)],
            ["Équivalent USD", formatMoney(transfer.usdEquivalentMinor, "USD")],
            ["Financement", transfer.fundingMethod],
            ["Versement", transfer.payoutMethod],
            ["Motif du statut", transfer.statusReason],
            ["Créé le", formatDateTime(transfer.createdAt)],
            ["Mis à jour le", formatDateTime(transfer.updatedAt)],
          ]}
        />
      </div>

      <div className="grid">
        <section>
          <h2>Historique</h2>
          <ol className="timeline">
            {transfer.history.map((event, index) => (
              <li key={`${event.at}-${index.toString()}`}>
                <strong>{label(TRANSFER_STATUS_LABELS, event.to)}</strong> — {formatDateTime(event.at)}
                <br />
                <span className="small muted">
                  {event.actor.type}
                  {event.actor.id === null ? "" : ` ${event.actor.id}`}
                  {event.reason === null ? "" : ` · ${event.reason}`}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h2>Évaluation LCB-FT</h2>
          {transfer.amlEvaluation === null ? (
            <p className="muted">Pas encore évalué.</p>
          ) : (
            <div className="card">
              <Details
                items={[
                  ["Résultat", <Badge key="o" value={transfer.amlEvaluation.outcome} />],
                  ["Score de risque", transfer.amlEvaluation.riskScore],
                  ["Évalué le", formatDateTime(transfer.amlEvaluation.evaluatedAt)],
                ]}
              />
              <Json value={transfer.amlEvaluation.rules} />
            </div>
          )}
          <h2>Alertes</h2>
          {transfer.alerts.length === 0 ? (
            <p className="muted">Aucune alerte.</p>
          ) : (
            <ul>
              {transfer.alerts.map((alert) => (
                <li key={alert.id}>
                  {can(admin, "aml:alerts:read") ? <Link href={`/aml/alertes/${alert.id}`}>{alert.rule}</Link> : alert.rule} — {label(SEVERITY_LABELS, alert.severity)},{" "}
                  {label(ALERT_STATUS_LABELS, alert.status)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <h2>Tentatives de paiement et de versement</h2>
      <table>
        <thead>
          <tr>
            <th>Sens</th>
            <th>Prestataire</th>
            <th>État</th>
            <th className="number">Montant</th>
            <th>Référence prestataire</th>
            <th>Échec</th>
            <th>Mise à jour</th>
          </tr>
        </thead>
        <tbody>
          {transfer.attempts.map((attempt) => (
            <tr key={attempt.id}>
              <td>{label(DIRECTION_LABELS, attempt.direction)}</td>
              <td>{attempt.provider}</td>
              <td>
                <Badge value={attempt.status} />
              </td>
              <td className="number amount">{formatMoney(attempt.amountMinor, attempt.currency)}</td>
              <td>
                <code>{attempt.providerReference ?? "—"}</code>
              </td>
              <td>{attempt.failureCode ?? "—"}</td>
              <td>{formatDateTime(attempt.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Écritures du registre</h2>
      <table>
        <thead>
          <tr>
            <th>Séquence</th>
            <th>Type</th>
            <th>Clé d&apos;idempotence</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {transfer.journals.map((journal) => (
            <tr key={journal.id}>
              <td>{can(admin, "ledger:read") ? <Link href={`/registre/journaux/${journal.id}`}>{journal.seq}</Link> : journal.seq}</td>
              <td>
                {journal.type}
                {journal.reversesJournalId !== null && <span className="badge">contre-passation</span>}
              </td>
              <td>
                <code>{journal.key}</code>
              </td>
              <td>{formatDateTime(journal.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Décisions</h2>
      <div className="grid">
        {can(admin, "transfers:hold") && HOLDABLE.includes(transfer.status) && (
          <ActionForm
            action={holdTransferAction.bind(null, transfer.id)}
            title="Mettre en revue de conformité"
            description="Bloque le versement jusqu'à décision. Impossible si le versement est déjà engagé chez le prestataire."
            fields={[{ name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 }]}
            submitLabel="Mettre en revue"
            tone="danger"
          />
        )}
        {can(admin, "transfers:release") && transfer.status === "compliance_review" && (
          <ActionForm
            action={releaseTransferAction.bind(null, transfer.id)}
            title="Libérer le transfert"
            description="Le versement reprend. Les alertes bloquantes doivent avoir été traitées."
            fields={[{ name: "note", label: "Note de décision", kind: "textarea", minLength: 10, maxLength: 2000 }]}
            confirmation="J'ai examiné les alertes et l'évaluation de ce transfert."
            submitLabel="Libérer"
          />
        )}
        {can(admin, "transfers:refund") && REFUNDABLE.includes(transfer.status) && (
          <ActionForm
            action={requestRefundAction.bind(null, transfer.id)}
            title="Demander le remboursement"
            fields={[
              { name: "reason", label: "Motif communiqué au client", kind: "textarea", minLength: 10, maxLength: 1000 },
              { name: "justification", label: "Justification interne", kind: "textarea", minLength: 10, maxLength: 1000 },
            ]}
            fourEyes={requiresFourEyes(admin, "transfers:refund")}
            submitLabel="Créer la demande"
            tone="danger"
          />
        )}
      </div>
    </>
  );
}
