import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty } from "@/components/ui";
import type { PayinMethod } from "@/lib/configuration";
import { CIRCUIT_LABELS, formatBps, FUNDING_METHOD_LABELS, PAYIN_FUNDING_METHODS, PROVIDER_LABELS, PROVIDERS } from "@/lib/configuration";
import { formatMoney } from "@/lib/format";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestPayinAction } from "../actions";
import { enabledField, JUSTIFICATION, routingFields } from "../fields";
import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Moyens d'encaissement" };

export default async function PayinMethodsPage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PayinMethod[] }>("/parametrage/encaissement", { path: "/v1/admin/configuration/payin-methods" });

  return (
    <>
      <h1>Moyens d&apos;encaissement</h1>
      <p className="muted">Moyens de paiement proposés aux clients pour financer un transfert, par pays et devise d&apos;envoi. Le solde du portefeuille n&apos;en fait pas partie.</p>
      {items.length === 0 ? (
        <Empty>Aucun moyen d&apos;encaissement.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Pays / devise</th>
              <th>Moyen</th>
              <th>Prestataire</th>
              <th className="number">Montants</th>
              <th className="number">Coût</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {items.map((method) => (
              <tr key={method.id}>
                <td>
                  <Link href={`/parametrage/encaissement/${method.id}`}>
                    {method.country} ({method.currency})
                  </Link>
                </td>
                <td>{FUNDING_METHOD_LABELS[method.fundingMethod]}</td>
                <td>
                  {PROVIDER_LABELS[method.provider]}
                  {!method.providerEnabled && " (désactivé)"}
                  {method.circuitState !== "closed" && <Badge value={method.circuitState} labels={CIRCUIT_LABELS} />}
                </td>
                <td className="number amount">
                  {formatMoney(method.minAmount, method.currency)} – {formatMoney(method.maxAmount, method.currency)}
                </td>
                <td className="number">
                  {formatMoney(method.costFixed, method.currency)} + {formatBps(method.costBps)}
                </td>
                <td>
                  <Badge value={method.isEnabled ? "active" : "disabled"} labels={{ active: "Ouvert", disabled: "Fermé" }} /> <PendingLink id={method.pendingRequestId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(admin, "routing:manage") && (
        <ActionForm
          action={requestPayinAction}
          title="Nouveau moyen d'encaissement"
          description="Montants et coûts dans la devise d'encaissement."
          fourEyes={requiresFourEyes(admin, "routing:manage")}
          fields={[
            { name: "country", label: "Pays d'envoi", kind: "text", maxLength: 2, placeholder: "FR" },
            { name: "currency", label: "Devise", kind: "text", maxLength: 3, placeholder: "EUR" },
            { name: "fundingMethod", label: "Moyen", kind: "select", options: PAYIN_FUNDING_METHODS.map((value) => ({ value, label: FUNDING_METHOD_LABELS[value] })) },
            { name: "provider", label: "Prestataire", kind: "select", options: PROVIDERS.map((value) => ({ value, label: PROVIDER_LABELS[value] })) },
            ...routingFields(null, null),
            enabledField(null),
            JUSTIFICATION,
          ]}
          submitLabel="Demander le nouveau moyen"
        />
      )}
    </>
  );
}
