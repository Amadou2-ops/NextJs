import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Details } from "@/components/ui";
import type { CountrySetting } from "@/lib/configuration";
import { RISK_LEVEL_LABELS, RISK_LEVELS } from "@/lib/configuration";
import { formatDateTime } from "@/lib/format";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestCountryAction } from "../../actions";
import { JUSTIFICATION, yesNoField } from "../../fields";
import { PendingLink } from "../../PendingLink";

export const metadata: Metadata = { title: "Pays" };

export default async function CountryPage({ params }: { readonly params: Promise<{ code: string }> }): Promise<ReactNode> {
  const { code } = await params;
  if (!/^[A-Z]{2}$/.test(code)) notFound();
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: CountrySetting[] }>(`/parametrage/pays/${code}`, { path: "/v1/admin/configuration/countries", query: { filter: "all" } });
  const country = items.find((item) => item.code === code);
  if (country === undefined) notFound();

  return (
    <>
      <h1>
        {country.name} ({country.code}) <PendingLink id={country.pendingRequestId} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Devise", country.defaultCurrency ?? "—"],
            ["Envoi", country.canSend ? "Ouvert" : "Fermé"],
            ["Réception", country.canReceive ? "Ouvert" : "Fermé"],
            ["Risque", RISK_LEVEL_LABELS[country.riskLevel]],
            ["Dernière revue", formatDateTime(country.riskReviewedAt)],
          ]}
        />
      </div>
      {can(admin, "countries:manage") && country.pendingRequestId === null && (
        <ActionForm
          action={requestCountryAction.bind(null, country.code)}
          title="Modifier l'ouverture et le risque"
          description="Ouvrir la réception ne suffit pas : il faut aussi un corridor ouvert et tarifé. Un pays interdit reste fermé."
          fourEyes={requiresFourEyes(admin, "countries:manage")}
          fields={[
            yesNoField("canSend", "Ouvert à l'envoi", country.canSend),
            yesNoField("canReceive", "Ouvert à la réception", country.canReceive),
            { name: "riskLevel", label: "Niveau de risque", kind: "select", options: RISK_LEVELS.map((value) => ({ value, label: RISK_LEVEL_LABELS[value] })), defaultValue: country.riskLevel },
            JUSTIFICATION,
          ]}
          submitLabel="Demander la modification"
        />
      )}
    </>
  );
}
