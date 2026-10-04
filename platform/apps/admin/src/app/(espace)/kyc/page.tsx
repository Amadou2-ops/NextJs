import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Empty, NoAccess } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { KycVerification } from "@/lib/types";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Revue d'identité" };

export default async function KycQueuePage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "kyc:read")) return <NoAccess permission="kyc:read" />;
  const { items } = await sessionApi<{ items: KycVerification[] }>("/kyc", { path: "/v1/admin/kyc/reviews", query: { limit: "100" } });
  return (
    <>
      <h1>Vérifications d&apos;identité à revoir</h1>
      <p className="muted">Dossiers que le prestataire n&apos;a pas pu trancher automatiquement, les plus anciens d&apos;abord.</p>
      {items.length === 0 ? (
        <Empty>Aucune vérification en attente.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Soumise le</th>
              <th>Client</th>
              <th>Prestataire</th>
              <th>Niveau demandé</th>
              <th>Vivant</th>
              <th>Correspondance</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/kyc/${item.id}`}>{formatDateTime(item.submittedAt ?? item.createdAt)}</Link>
                </td>
                <td>{item.customerNumber}</td>
                <td>{item.provider}</td>
                <td>{item.tier}</td>
                <td>{item.livenessScore ?? "—"}</td>
                <td>{item.documentMatchScore ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
