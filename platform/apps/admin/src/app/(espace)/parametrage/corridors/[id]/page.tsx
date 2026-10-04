import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details } from "@/components/ui";
import type { PayoutCorridor } from "@/lib/configuration";
import { CIRCUIT_LABELS, formatBps, PAYOUT_METHOD_LABELS, PROVIDER_LABELS, scope } from "@/lib/configuration";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestCorridorChangeAction } from "../../actions";
import { enabledField, JUSTIFICATION, routingFields } from "../../fields";
import { PendingLink } from "../../PendingLink";

export const metadata: Metadata = { title: "Corridor" };

export default async function CorridorPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PayoutCorridor[] }>(`/parametrage/corridors/${id}`, { path: "/v1/admin/configuration/payout-corridors" });
  const corridor = items.find((item) => item.id === id);
  if (corridor === undefined) notFound();
  const currency = corridor.destinationCurrency;

  return (
    <>
      <h1>
        Corridor {scope(corridor.sourceCountry, "tous pays")} → {corridor.destinationCountry} ({currency}) <PendingLink id={corridor.pendingRequestId} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Mode de réception", PAYOUT_METHOD_LABELS[corridor.payoutMethod]],
            ["Prestataire", `${PROVIDER_LABELS[corridor.provider]}${corridor.providerEnabled ? "" : " (désactivé)"}`],
            ["Disjoncteur", <Badge key="c" value={corridor.circuitState} labels={CIRCUIT_LABELS} />],
            ["Code du payeur", corridor.providerRouteCode ?? "—"],
            ["Montants", `${formatMoney(corridor.minAmount, currency)} – ${formatMoney(corridor.maxAmount, currency)}`],
            ["Coût prestataire", `${formatMoney(corridor.costFixed, currency)} + ${formatBps(corridor.costBps)}`],
            ["Délai", `${corridor.estimatedDeliveryMinutes.toString()} min`],
            ["Priorité", corridor.priority],
            ["État", corridor.isEnabled ? "Ouvert" : "Fermé"],
            ["Dernière modification", formatDateTime(corridor.updatedAt)],
          ]}
        />
      </div>
      {can(admin, "routing:manage") && (
        <ActionForm
          action={requestCorridorChangeAction.bind(null, corridor.id, currency)}
          title="Modifier le corridor"
          description={`Montants et coûts en ${currency}. Pays, devise, mode et prestataire sont figés : pour les changer, créer un autre corridor.`}
          fourEyes={requiresFourEyes(admin, "routing:manage")}
          fields={[
            ...routingFields(corridor, currency),
            { name: "estimatedDeliveryMinutes", label: "Délai de mise à disposition (minutes)", kind: "text", maxLength: 5, defaultValue: corridor.estimatedDeliveryMinutes.toString() },
            { name: "providerRouteCode", label: "Code du payeur chez le prestataire", kind: "text", required: false, maxLength: 40, ...(corridor.providerRouteCode === null ? {} : { defaultValue: corridor.providerRouteCode }) },
            enabledField(corridor),
            JUSTIFICATION,
          ]}
          submitLabel="Demander la modification"
        />
      )}
    </>
  );
}
