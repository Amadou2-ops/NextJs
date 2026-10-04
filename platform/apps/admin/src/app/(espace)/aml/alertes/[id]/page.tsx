import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, Json, NoAccess } from "@/components/ui";
import { ALERT_STATUS_LABELS, formatDateTime, SEVERITY_LABELS } from "@/lib/format";
import type { AmlAlertDetail } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { assignAlertAction, escalateAlertAction, resolveAlertAction } from "../../actions";

export const metadata: Metadata = { title: "Alerte" };

const OPEN = new Set(["open", "under_review", "escalated"]);

export default async function AlertPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "aml:alerts:read")) return <NoAccess permission="aml:alerts:read" />;
  const alert = await sessionApi<AmlAlertDetail>(`/aml/alertes/${id}`, { path: `/v1/admin/aml/alerts/${id}` });
  const open = OPEN.has(alert.status);
  const manage = can(admin, "aml:alerts:manage") && open;
  const sanctions = alert.rule.code === "SANCTIONS_POTENTIAL_MATCH";

  return (
    <>
      <h1>
        {alert.rule.code} <Badge value={alert.severity} labels={SEVERITY_LABELS} /> <Badge value={alert.status} labels={ALERT_STATUS_LABELS} />
      </h1>
      <p>{alert.rule.description}</p>
      <div className="card">
        <Details
          items={[
            ["Client", can(admin, "customers:read") ? <Link key="c" href={`/clients/${alert.userId}`}>{alert.customerNumber}</Link> : alert.customerNumber],
            ["Transfert", alert.transferId === null ? "—" : <Link key="t" href={`/transferts/${alert.transferId}`}>{alert.transferReference ?? alert.transferId}</Link>],
            ["Bloque le transfert", alert.rule.blocksTransfer ? "Oui" : "Non"],
            ["Score", alert.score],
            ["Attribuée à", alert.assignee?.name],
            ["Créée le", formatDateTime(alert.createdAt)],
            ["Close le", formatDateTime(alert.resolvedAt)],
            ["Note de clôture", alert.resolutionNote],
          ]}
        />
      </div>
      <h2>Éléments déclencheurs</h2>
      <Json value={alert.details} />
      {alert.screening !== null && (
        <>
          <h2>Criblage</h2>
          <div className="card">
            <Details
              items={[
                ["Sujet", alert.screening.subject],
                ["Résultat", <Badge key="s" value={alert.screening.status} />],
                ["Criblé le", formatDateTime(alert.screening.screenedAt)],
              ]}
            />
            <h3>Correspondances</h3>
            <Json value={alert.screening.matches} />
            <h3>Versions des listes</h3>
            <Json value={alert.screening.lists} />
          </div>
        </>
      )}

      {manage && (
        <>
          <h2>Traitement</h2>
          <div className="grid">
            {alert.assignee?.id !== admin.id && (
              <ActionForm action={assignAlertAction.bind(null, alert.id)} title="Prendre en charge" fields={[]} submitLabel="M'attribuer l'alerte" />
            )}
            {alert.status !== "escalated" && (
              <ActionForm
                action={escalateAlertAction.bind(null, alert.id)}
                title="Escalader"
                fields={[{ name: "note", label: "Note", kind: "textarea", minLength: 10, maxLength: 2000 }]}
                submitLabel="Escalader"
              />
            )}
            <ActionForm
              action={resolveAlertAction.bind(null, alert.id)}
              title="Clore l'alerte"
              description={
                sanctions
                  ? "Une correspondance de sanctions confirmée gèle le profil du client : plus aucun transfert ; ses transferts restent bloqués jusqu'à décision."
                  : undefined
              }
              fields={[
                {
                  name: "outcome",
                  label: "Conclusion",
                  kind: "select",
                  options: [
                    { value: "false_positive", label: "Faux positif" },
                    { value: "confirmed", label: "Confirmée" },
                  ],
                },
                { name: "note", label: "Note de clôture", kind: "textarea", minLength: 10, maxLength: 2000 },
              ]}
              submitLabel="Clore"
              tone="danger"
            />
          </div>
        </>
      )}
    </>
  );
}
