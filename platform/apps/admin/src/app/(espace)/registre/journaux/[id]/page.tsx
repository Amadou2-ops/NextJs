import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Details, Json, NoAccess } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { LedgerJournal } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestReversalAction } from "../../actions";

export const metadata: Metadata = { title: "Journal comptable" };

export default async function JournalPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "ledger:read")) return <NoAccess permission="ledger:read" />;
  const journal = await sessionApi<LedgerJournal>(`/registre/journaux/${id}`, { path: `/v1/admin/ledger/journals/${id}` });
  const reversible = journal.reversedByJournalId === null && journal.reversesJournalId === null;

  return (
    <>
      <h1>
        Journal n° {journal.sequence} · {journal.type}
      </h1>
      <div className="card">
        <Details
          items={[
            ["Identifiant", <code key="i">{journal.id}</code>],
            ["Clé d'idempotence", <code key="k">{journal.idempotencyKey}</code>],
            ["Référence", journal.reference === null ? "—" : journal.reference.type === "transfer" && journal.reference.id !== null ? <Link key="r" href={`/transferts/${journal.reference.id}`}>transfert {journal.reference.id}</Link> : `${journal.reference.type} ${journal.reference.id ?? ""}`],
            ["Libellé", journal.description],
            ["Date de valeur", formatDateTime(journal.effectiveAt)],
            ["Enregistré le", formatDateTime(journal.createdAt)],
            ["Contre-passe", journal.reversesJournalId === null ? "—" : <Link key="rv" href={`/registre/journaux/${journal.reversesJournalId}`}>{journal.reversesJournalId}</Link>],
            ["Contre-passé par", journal.reversedByJournalId === null ? "—" : <Link key="rb" href={`/registre/journaux/${journal.reversedByJournalId}`}>{journal.reversedByJournalId}</Link>],
            ["Empreinte", <code key="h">{journal.hash}</code>],
            ["Empreinte précédente", <code key="p">{journal.previousHash}</code>],
          ]}
        />
      </div>
      <h2>Lignes</h2>
      <table>
        <thead>
          <tr>
            <th>Ligne</th>
            <th>Compte</th>
            <th className="number">Débit</th>
            <th className="number">Crédit</th>
            <th className="number">Solde après</th>
          </tr>
        </thead>
        <tbody>
          {journal.entries.map((entry) => (
            <tr key={entry.line}>
              <td>{entry.line}</td>
              <td>
                <Link href={`/registre/comptes/${entry.accountId}`}>{entry.accountCode}</Link>
              </td>
              <td className="number amount">{entry.direction === "debit" ? formatMoney(entry.amount.amount, entry.amount.currency) : ""}</td>
              <td className="number amount">{entry.direction === "credit" ? formatMoney(entry.amount.amount, entry.amount.currency) : ""}</td>
              <td className="number amount">{formatMoney(entry.balanceAfter.amount, entry.balanceAfter.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Auteur et métadonnées</h2>
      <Json value={{ actor: journal.actor, metadata: journal.metadata }} />

      {can(admin, "ledger:adjust") && reversible && (
        <ActionForm
          action={requestReversalAction.bind(null, journal.id)}
          title="Demander la contre-passation"
          description="Un journal miroir annulera exactement ces lignes ; le journal d'origine reste inchangé."
          fields={[
            { name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 },
            { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
          ]}
          fourEyes={requiresFourEyes(admin, "ledger:adjust")}
          submitLabel="Créer la demande"
          tone="danger"
        />
      )}
    </>
  );
}
