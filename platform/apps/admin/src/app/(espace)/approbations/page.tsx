import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NoAccess } from "@/components/ui";
import { ACTION_TYPE_LABELS, APPROVAL_STATUS_LABELS, formatDateTime, label } from "@/lib/format";
import type { Approval } from "@/lib/types";
import { APPROVAL_STATUSES } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Approbations" };

export default async function ApprovalsPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "approvals:decide")) return <NoAccess permission="approvals:decide" />;
  const status = oneOf(single((await searchParams)["status"]), APPROVAL_STATUSES) ?? "pending";
  const { items } = await sessionApi<{ items: Approval[] }>("/approbations", { path: "/v1/admin/approvals", query: { status, limit: "100" } });

  return (
    <>
      <h1>Demandes à double validation</h1>
      <p className="muted">Une action sensible n&apos;est exécutée qu&apos;après l&apos;accord d&apos;un second membre habilité, qui l&apos;exécute lui-même. Les demandes expirent après 24 heures.</p>
      <nav className="tabs" aria-label="Filtrer par état">
        {APPROVAL_STATUSES.map((value) => (
          <Link key={value} href={withQuery("/approbations", { status: value })} aria-current={value === status ? "page" : undefined}>
            {APPROVAL_STATUS_LABELS[value]}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <Empty>Aucune demande dans cet état.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Demandée par</th>
              <th>Le</th>
              <th>Expire</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/approbations/${item.id}`}>{label(ACTION_TYPE_LABELS, item.actionType)}</Link>
                  {item.requestedBy.id === admin.id && <span className="badge"> votre demande</span>}
                </td>
                <td>{item.requestedBy.name}</td>
                <td>{formatDateTime(item.requestedAt)}</td>
                <td>{formatDateTime(item.expiresAt)}</td>
                <td>
                  <Badge value={item.status} labels={APPROVAL_STATUS_LABELS} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
