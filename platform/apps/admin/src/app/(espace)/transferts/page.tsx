import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NextPage, NoAccess } from "@/components/ui";
import { formatDateTime, formatMoney, TRANSFER_STATUS_LABELS } from "@/lib/format";
import type { Page, TransferSummary } from "@/lib/types";
import { TRANSFER_STATUSES } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single, UUID_PATTERN, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Transferts" };

const REFERENCE = /^TP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;
const CURSOR = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

export default async function TransfersPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "transfers:read")) return <NoAccess permission="transfers:read" />;
  const params = await searchParams;
  const status = oneOf(single(params["status"]), TRANSFER_STATUSES);
  const userIdInput = single(params["userId"]);
  const userId = userIdInput !== undefined && UUID_PATTERN.test(userIdInput) ? userIdInput : undefined;
  const referenceInput = single(params["reference"])?.trim().toUpperCase();
  const reference = referenceInput !== undefined && REFERENCE.test(referenceInput) ? referenceInput : undefined;
  const beforeInput = single(params["before"]);
  const before = beforeInput !== undefined && CURSOR.test(beforeInput) ? beforeInput : undefined;
  const invalidReference = referenceInput !== undefined && reference === undefined;

  const page = invalidReference
    ? { items: [], nextCursor: null }
    : await sessionApi<Page<TransferSummary>>("/transferts", { path: "/v1/admin/transfers", query: { status, userId, reference, before, limit: "50" } });

  return (
    <>
      <h1>Transferts</h1>
      <form className="filters" method="get" action="/transferts" role="search">
        <label>
          Référence
          <input name="reference" defaultValue={referenceInput} placeholder="TP…" maxLength={12} autoComplete="off" aria-invalid={invalidReference} />
        </label>
        <label>
          Client (identifiant)
          <input name="userId" defaultValue={userId} maxLength={36} autoComplete="off" />
        </label>
        <label>
          Statut
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Tous</option>
            {TRANSFER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TRANSFER_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrer</button>
      </form>
      {invalidReference && <p className="alert error">Référence invalide (TP suivi de 10 caractères).</p>}
      {page.items.length === 0 ? (
        <Empty>Aucun transfert.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Référence</th>
              <th>Créé le</th>
              <th>Corridor</th>
              <th className="number">Envoyé</th>
              <th className="number">Reçu</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((transfer) => (
              <tr key={transfer.id}>
                <td>
                  <Link href={`/transferts/${transfer.id}`}>{transfer.reference}</Link>
                </td>
                <td>{formatDateTime(transfer.createdAt)}</td>
                <td>
                  {transfer.corridor.from} → {transfer.corridor.to}
                </td>
                <td className="number amount">{formatMoney(transfer.send.amountMinor, transfer.send.currency)}</td>
                <td className="number amount">{formatMoney(transfer.receive.amountMinor, transfer.receive.currency)}</td>
                <td>
                  <Badge value={transfer.status} labels={TRANSFER_STATUS_LABELS} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NextPage href={page.nextCursor === null ? null : withQuery("/transferts", { status, userId, reference, before: page.nextCursor })} />
    </>
  );
}
