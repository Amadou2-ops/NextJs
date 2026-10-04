import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details } from "@/components/ui";
import type { PayinMethod } from "@/lib/configuration";
import { CIRCUIT_LABELS, formatBps, FUNDING_METHOD_LABELS, PROVIDER_LABELS } from "@/lib/configuration";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestPayinChangeAction } from "../../actions";
import { enabledField, JUSTIFICATION, routingFields } from "../../fields";
import { PendingLink } from "../../PendingLink";

export const metadata: Metadata = { title: "Moyen d'encaissement" };

export default async function PayinMethodPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PayinMethod[] }>(`/parametrage/encaissement/${id}`, { path: "/v1/admin/configuration/payin-methods" });
  const method = items.find((item) => item.id === id);
  if (method === undefined) notFound();

  return (
    <>
      <h1>
        {FUNDING_METHOD_LABELS[method.fundingMethod]} · {method.country} ({method.currency}) <PendingLink id={method.pendingRequestId} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Prestataire", `${PROVIDER_LABELS[method.provider]}${method.providerEnabled ? "" : " (désactivé)"}`],
            ["Disjoncteur", <Badge key="c" value={method.circuitState} labels={CIRCUIT_LABELS} />],
            ["Montants", `${formatMoney(method.minAmount, method.currency)} – ${formatMoney(method.maxAmount, method.currency)}`],
            ["Coût prestataire", `${formatMoney(method.costFixed, method.currency)} + ${formatBps(method.costBps)}`],
            ["Priorité", method.priority],
            ["État", method.isEnabled ? "Ouvert" : "Fermé"],
            ["Dernière modification", formatDateTime(method.updatedAt)],
          ]}
        />
      </div>
      {can(admin, "routing:manage") && (
        <ActionForm
          action={requestPayinChangeAction.bind(null, method.id, method.currency)}
          title="Modifier le moyen d'encaissement"
          description={`Montants et coûts en ${method.currency}. Pays, devise, moyen et prestataire sont figés.`}
          fourEyes={requiresFourEyes(admin, "routing:manage")}
          fields={[...routingFields(method, method.currency), enabledField(method), JUSTIFICATION]}
          submitLabel="Demander la modification"
        />
      )}
    </>
  );
}
