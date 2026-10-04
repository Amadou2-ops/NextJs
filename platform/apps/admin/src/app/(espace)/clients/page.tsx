import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NoAccess } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { CustomerStatus, CustomerSummary } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Clients" };

const STATUSES: readonly CustomerStatus[] = ["pending_verification", "active", "suspended", "closed"];
const STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = { pending_verification: "En attente", active: "Actif", suspended: "Suspendu", closed: "Fermé" };

/**
 * Recherche exacte uniquement (numéro client, identifiant, téléphone E.164,
 * e-mail) : les coordonnées ne sont interrogeables que par index aveugle.
 */
export default async function CustomersPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "customers:read")) return <NoAccess permission="customers:read" />;
  const params = await searchParams;
  const q = single(params["q"])?.slice(0, 254);
  const status = oneOf(single(params["status"]), STATUSES);
  const { items } = await sessionApi<{ items: CustomerSummary[] }>("/clients", { path: "/v1/admin/customers", query: { q, status, limit: "50" } });

  return (
    <>
      <h1>Clients</h1>
      <form className="filters" method="get" action="/clients" role="search">
        <label>
          Numéro client, identifiant, téléphone ou e-mail (exact)
          <input name="q" defaultValue={q} maxLength={254} autoComplete="off" />
        </label>
        <label>
          Statut
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Tous</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Rechercher</button>
      </form>
      {items.length === 0 ? (
        <Empty>Aucun client ne correspond.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>N° client</th>
              <th>Statut</th>
              <th>Niveau KYC</th>
              <th>Résidence</th>
              <th>Risque</th>
              <th>Inscrit le</th>
            </tr>
          </thead>
          <tbody>
            {items.map((customer) => (
              <tr key={customer.id}>
                <td>
                  <Link href={`/clients/${customer.id}`}>{customer.customerNumber}</Link>
                </td>
                <td>
                  <Badge value={customer.status} labels={STATUS_LABELS} />
                </td>
                <td>{customer.kycTier}</td>
                <td>{customer.countryOfResidence}</td>
                <td>{customer.riskLevel ?? "—"}</td>
                <td>{formatDateTime(customer.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
