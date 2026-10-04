import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty } from "@/components/ui";
import type { CountrySetting } from "@/lib/configuration";
import { RISK_LEVEL_LABELS } from "@/lib/configuration";
import { formatDateTime } from "@/lib/format";
import type { SearchParams } from "@/lib/url";
import { single } from "@/lib/url";
import { sessionApi } from "@/server/context";

import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Pays" };

const RISK_TONES: Readonly<Record<string, string>> = { low: "active", medium: "pending", high: "high", prohibited: "critical" };

export default async function CountriesPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const all = single((await searchParams)["filtre"]) === "tous";
  const { items } = await sessionApi<{ items: CountrySetting[] }>("/parametrage/pays", { path: "/v1/admin/configuration/countries", query: { filter: all ? "all" : "open" } });

  return (
    <>
      <h1>Pays</h1>
      <p className="muted">
        Ouverture à l&apos;envoi (pays de résidence du client) et à la réception (pays du bénéficiaire), et niveau de risque utilisé par les règles LCB-FT.
        Un pays interdit reste fermé, quelle que soit la demande.
      </p>
      <nav className="tabs" aria-label="Filtrer les pays">
        <Link href="/parametrage/pays" aria-current={all ? undefined : "page"}>
          Ouverts
        </Link>
        <Link href="/parametrage/pays?filtre=tous" aria-current={all ? "page" : undefined}>
          Tous
        </Link>
      </nav>
      {items.length === 0 ? (
        <Empty>Aucun pays ouvert.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Pays</th>
              <th>Devise</th>
              <th>Envoi</th>
              <th>Réception</th>
              <th>Risque</th>
              <th>Revu le</th>
            </tr>
          </thead>
          <tbody>
            {items.map((country) => (
              <tr key={country.code}>
                <td>
                  <Link href={`/parametrage/pays/${country.code}`}>
                    {country.name} ({country.code})
                  </Link>{" "}
                  <PendingLink id={country.pendingRequestId} />
                </td>
                <td>{country.defaultCurrency ?? "—"}</td>
                <td>{country.canSend ? "Ouvert" : "Fermé"}</td>
                <td>{country.canReceive ? "Ouvert" : "Fermé"}</td>
                <td>
                  <Badge value={country.riskLevel} labels={RISK_LEVEL_LABELS} tone={RISK_TONES[country.riskLevel] ?? country.riskLevel} />
                </td>
                <td>{formatDateTime(country.riskReviewedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
