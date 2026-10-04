import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty } from "@/components/ui";
import type { PayoutCorridor } from "@/lib/configuration";
import { CIRCUIT_LABELS, formatBps, PAYOUT_METHOD_LABELS, PAYOUT_METHODS, PROVIDER_LABELS, PROVIDERS, scope } from "@/lib/configuration";
import { formatMoney } from "@/lib/format";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestCorridorAction } from "../actions";
import { enabledField, JUSTIFICATION, routingFields } from "../fields";
import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Corridors de paiement sortant" };

export default async function CorridorsPage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PayoutCorridor[] }>("/parametrage/corridors", { path: "/v1/admin/configuration/payout-corridors" });

  return (
    <>
      <h1>Corridors de paiement sortant</h1>
      <p className="muted">
        Un corridor relie un pays et une devise de destination, un mode de réception et un prestataire. Il n&apos;est proposé aux clients que s&apos;il est
        ouvert, que son prestataire est activé et que le pays de destination est ouvert à la réception.
      </p>
      {items.length === 0 ? (
        <Empty>Aucun corridor.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Destination</th>
              <th>Réception</th>
              <th>Prestataire</th>
              <th className="number">Montants</th>
              <th className="number">Coût</th>
              <th className="number">Délai</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {items.map((corridor) => (
              <tr key={corridor.id}>
                <td>
                  <Link href={`/parametrage/corridors/${corridor.id}`}>
                    {scope(corridor.sourceCountry, "Tous")} → {corridor.destinationCountry} ({corridor.destinationCurrency})
                  </Link>
                </td>
                <td>{PAYOUT_METHOD_LABELS[corridor.payoutMethod]}</td>
                <td>
                  {PROVIDER_LABELS[corridor.provider]}
                  {!corridor.providerEnabled && " (désactivé)"}
                  {corridor.circuitState !== "closed" && <Badge value={corridor.circuitState} labels={CIRCUIT_LABELS} />}
                </td>
                <td className="number amount">
                  {formatMoney(corridor.minAmount, corridor.destinationCurrency)} – {formatMoney(corridor.maxAmount, corridor.destinationCurrency)}
                </td>
                <td className="number">
                  {formatMoney(corridor.costFixed, corridor.destinationCurrency)} + {formatBps(corridor.costBps)}
                </td>
                <td className="number">{corridor.estimatedDeliveryMinutes} min</td>
                <td>
                  <Badge value={corridor.isEnabled ? "active" : "disabled"} labels={{ active: "Ouvert", disabled: "Fermé" }} /> <PendingLink id={corridor.pendingRequestId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(admin, "routing:manage") && (
        <ActionForm
          action={requestCorridorAction}
          title="Nouveau corridor"
          description="Montants et coûts dans la devise de destination. Un corridor existant (même pays, devise, mode et prestataire) se modifie depuis sa fiche."
          fourEyes={requiresFourEyes(admin, "routing:manage")}
          fields={[
            { name: "sourceCountry", label: "Pays d'envoi", kind: "text", required: false, maxLength: 2, help: "Vide : tous les pays ouverts à l'envoi." },
            { name: "destinationCountry", label: "Pays de destination", kind: "text", maxLength: 2, placeholder: "SN" },
            { name: "destinationCurrency", label: "Devise reçue", kind: "text", maxLength: 3, placeholder: "XOF" },
            { name: "payoutMethod", label: "Mode de réception", kind: "select", options: PAYOUT_METHODS.map((value) => ({ value, label: PAYOUT_METHOD_LABELS[value] })) },
            { name: "provider", label: "Prestataire", kind: "select", options: PROVIDERS.map((value) => ({ value, label: PROVIDER_LABELS[value] })) },
            { name: "providerRouteCode", label: "Code du payeur chez le prestataire", kind: "text", required: false, maxLength: 40, help: "Obligatoire pour Thunes (identifiant du payeur)." },
            ...routingFields(null, null),
            { name: "estimatedDeliveryMinutes", label: "Délai de mise à disposition (minutes)", kind: "text", maxLength: 5, defaultValue: "60" },
            enabledField(null),
            JUSTIFICATION,
          ]}
          submitLabel="Demander le nouveau corridor"
        />
      )}
    </>
  );
}
