import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, NextPage, NoAccess } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { LedgerAccount, LedgerEntries } from "@/lib/types";
import type { IdParams, SearchParams } from "@/lib/url";
import { single, UUID_PATTERN, withQuery } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestAccountStatusAction } from "../../actions";

export const metadata: Metadata = { title: "Compte du registre" };

export default async function AccountPage({ params, searchParams }: { readonly params: IdParams; readonly searchParams: SearchParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "ledger:read")) return <NoAccess permission="ledger:read" />;
  const beforeInput = single((await searchParams)["avant"]);
  const before = beforeInput !== undefined && /^[1-9]\d{0,17}$/.test(beforeInput) ? beforeInput : undefined;
  const [account, statement] = await Promise.all([
    sessionApi<LedgerAccount>(`/registre/comptes/${id}`, { path: `/v1/admin/ledger/accounts/${id}` }),
    sessionApi<LedgerEntries>(`/registre/comptes/${id}`, { path: `/v1/admin/ledger/accounts/${id}/entries`, query: { before, limit: "50" } }),
  ]);
  const negative = account.balance.amount.startsWith("-");

  return (
    <>
      <h1>
        Compte {account.code} <Badge value={account.status} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Identifiant", <code key="i">{account.id}</code>],
            ["Type", account.type],
            ["Sens normal", account.normalSide === "debit" ? "Débiteur" : "Créditeur"],
            ["Devise", account.currency],
            ["Solde", <strong key="b" className={negative ? "amount negative" : "amount"}>{formatMoney(account.balance.amount, account.balance.currency)}</strong>],
            ["Solde négatif autorisé", account.allowNegative ? "Oui (compte technique)" : "Non"],
            ["Client", account.ownerUserId === null ? "—" : can(admin, "customers:read") ? <Link key="o" href={`/clients/${account.ownerUserId}`}>{account.ownerUserId}</Link> : account.ownerUserId],
            ["Prestataire", account.provider],
            ["Motif de l'état", account.statusReason],
            ["Écritures", account.entryCount],
            ["Ouvert le", formatDateTime(account.createdAt)],
          ]}
        />
      </div>

      <h2>Écritures</h2>
      <table>
        <thead>
          <tr>
            <th>N°</th>
            <th>Date de valeur</th>
            <th>Journal</th>
            <th>Libellé</th>
            <th className="number">Débit</th>
            <th className="number">Crédit</th>
            <th className="number">Solde après</th>
          </tr>
        </thead>
        <tbody>
          {statement.entries.map((entry) => (
            <tr key={entry.entryId}>
              <td>{entry.sequence}</td>
              <td>{formatDateTime(entry.effectiveAt)}</td>
              <td>
                <Link href={`/registre/journaux/${entry.journalId}`}>{entry.journalType}</Link>
              </td>
              <td>{entry.description ?? "—"}</td>
              <td className="number amount">{entry.direction === "debit" ? formatMoney(entry.amount.amount, entry.amount.currency) : ""}</td>
              <td className="number amount">{entry.direction === "credit" ? formatMoney(entry.amount.amount, entry.amount.currency) : ""}</td>
              <td className="number amount">{formatMoney(entry.balanceAfter.amount, entry.balanceAfter.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <NextPage href={statement.nextCursor === null ? null : withQuery(`/registre/comptes/${account.id}`, { avant: statement.nextCursor })} />

      {can(admin, "ledger:freeze") && (account.status === "active" || account.status === "frozen") && (
        <ActionForm
          action={requestAccountStatusAction.bind(null, account.id)}
          title={account.status === "frozen" ? "Demander le dégel" : "Demander le gel"}
          description={account.status === "frozen" ? undefined : "Un compte gelé n'accepte plus aucune écriture (la base le refuse)."}
          fields={[
            {
              name: "status",
              label: "Nouvel état",
              kind: "select",
              options: account.status === "frozen" ? [{ value: "active", label: "Actif" }] : [{ value: "frozen", label: "Gelé" }],
            },
            { name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 },
            { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
          ]}
          fourEyes={requiresFourEyes(admin, "ledger:freeze")}
          submitLabel="Créer la demande"
          tone={account.status === "frozen" ? "primary" : "danger"}
        />
      )}
    </>
  );
}
