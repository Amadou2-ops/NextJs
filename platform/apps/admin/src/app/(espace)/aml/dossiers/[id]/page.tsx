import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, NoAccess } from "@/components/ui";
import { ALERT_STATUS_LABELS, CASE_STATUS_LABELS, formatDateTime, SEVERITY_LABELS } from "@/lib/format";
import type { AmlCaseDetail } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { linkAlertsAction, requestSarAction, transitionCaseAction } from "../../actions";

export const metadata: Metadata = { title: "Dossier d'enquête" };

export default async function CasePage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "aml:alerts:read")) return <NoAccess permission="aml:alerts:read" />;
  const item = await sessionApi<AmlCaseDetail>(`/aml/dossiers/${id}`, { path: `/v1/admin/aml/cases/${id}` });
  const manage = can(admin, "aml:cases:manage") && item.status !== "closed";

  return (
    <>
      <h1>
        Dossier n° {item.caseNumber} <Badge value={item.status} labels={CASE_STATUS_LABELS} />
      </h1>
      <div className="card">
        <p>{item.summary}</p>
        <Details
          items={[
            ["Client", can(admin, "customers:read") ? <Link key="c" href={`/clients/${item.userId}`}>{item.userId}</Link> : item.userId],
            ["Ouvert le", formatDateTime(item.createdAt)],
            ["Déclaration de soupçon", item.sarReference === null ? "—" : `${item.sarReference} (${formatDateTime(item.sarFiledAt)})`],
            ["Clos le", formatDateTime(item.closedAt)],
            ["Note de clôture", item.closureNote],
          ]}
        />
      </div>
      <h2>Alertes rattachées</h2>
      {item.alerts.length === 0 ? (
        <p className="muted">Aucune alerte rattachée.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Règle</th>
              <th>Gravité</th>
              <th>Transfert</th>
              <th>État</th>
              <th>Créée le</th>
            </tr>
          </thead>
          <tbody>
            {item.alerts.map((alert) => (
              <tr key={alert.id}>
                <td>
                  <Link href={`/aml/alertes/${alert.id}`}>{alert.rule.code}</Link>
                </td>
                <td>
                  <Badge value={alert.severity} labels={SEVERITY_LABELS} />
                </td>
                <td>{alert.transferReference ?? "—"}</td>
                <td>
                  <Badge value={alert.status} labels={ALERT_STATUS_LABELS} />
                </td>
                <td>{formatDateTime(alert.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(manage || (can(admin, "aml:sar:file") && item.status !== "closed" && item.status !== "sar_filed")) && <h2>Actions</h2>}
      <div className="grid">
        {manage && (
          <>
            <ActionForm
              action={transitionCaseAction.bind(null, item.id)}
              title="Changer l'état"
              fields={[
                {
                  name: "status",
                  label: "Nouvel état",
                  kind: "select",
                  options: [
                    { value: "investigating", label: "En enquête" },
                    { value: "closed", label: "Clos" },
                  ],
                },
                { name: "note", label: "Note", kind: "textarea", minLength: 10, maxLength: 2000 },
              ]}
              submitLabel="Enregistrer"
            />
            <ActionForm
              action={linkAlertsAction.bind(null, item.id)}
              title="Rattacher des alertes"
              fields={[{ name: "alertIds", label: "Identifiants d'alertes (un par ligne)", kind: "textarea", maxLength: 4000 }]}
              submitLabel="Rattacher"
            />
          </>
        )}
        {can(admin, "aml:sar:file") && item.status !== "closed" && item.status !== "sar_filed" && (
          <ActionForm
            action={requestSarAction.bind(null, item.id)}
            title="Enregistrer la déclaration de soupçon"
            description="Référence de la déclaration transmise à la cellule de renseignement financier."
            fields={[
              { name: "sarReference", label: "Référence de la déclaration", kind: "text", maxLength: 100 },
              { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
            ]}
            fourEyes={requiresFourEyes(admin, "aml:sar:file")}
            submitLabel="Créer la demande"
          />
        )}
      </div>
    </>
  );
}
