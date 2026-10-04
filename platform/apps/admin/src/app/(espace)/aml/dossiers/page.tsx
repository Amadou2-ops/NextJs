import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NoAccess } from "@/components/ui";
import { CASE_STATUS_LABELS, formatDateTime } from "@/lib/format";
import type { AmlCaseSummary } from "@/lib/types";
import { CASE_STATUSES } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Dossiers d'enquête" };

export default async function CasesPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "aml:alerts:read")) return <NoAccess permission="aml:alerts:read" />;
  const status = oneOf(single((await searchParams)["status"]), CASE_STATUSES);
  const { items } = await sessionApi<{ items: AmlCaseSummary[] }>("/aml/dossiers", { path: "/v1/admin/aml/cases", query: { status, limit: "100" } });

  return (
    <>
      <h1>Dossiers d&apos;enquête</h1>
      <nav className="tabs" aria-label="Filtrer par état">
        <Link href="/aml/dossiers" aria-current={status === undefined ? "page" : undefined}>
          En cours
        </Link>
        {CASE_STATUSES.map((value) => (
          <Link key={value} href={withQuery("/aml/dossiers", { status: value })} aria-current={value === status ? "page" : undefined}>
            {CASE_STATUS_LABELS[value]}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <Empty>Aucun dossier.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>N°</th>
              <th>Résumé</th>
              <th>Alertes</th>
              <th>État</th>
              <th>Ouvert le</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/aml/dossiers/${item.id}`}>{item.caseNumber}</Link>
                </td>
                <td>{item.summary.length > 140 ? `${item.summary.slice(0, 140)}…` : item.summary}</td>
                <td>{item.alertCount}</td>
                <td>
                  <Badge value={item.status} labels={CASE_STATUS_LABELS} />
                </td>
                <td>{formatDateTime(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
