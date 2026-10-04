import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NoAccess } from "@/components/ui";
import { ALERT_STATUS_LABELS, formatDateTime, SEVERITY_LABELS } from "@/lib/format";
import type { AmlAlert } from "@/lib/types";
import { ALERT_STATUSES, SEVERITIES } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Alertes LCB-FT" };

export default async function AlertsPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "aml:alerts:read")) return <NoAccess permission="aml:alerts:read" />;
  const params = await searchParams;
  const status = oneOf(single(params["status"]), ALERT_STATUSES);
  const severity = oneOf(single(params["severity"]), SEVERITIES);
  const mine = single(params["mine"]) === "true" ? "true" : undefined;
  const { items } = await sessionApi<{ items: AmlAlert[] }>("/aml/alertes", { path: "/v1/admin/aml/alerts", query: { status, severity, mine, limit: "100" } });

  return (
    <>
      <h1>Alertes LCB-FT</h1>
      <form className="filters" method="get" action="/aml/alertes">
        <label>
          État
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Ouvertes (toutes)</option>
            {ALERT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {ALERT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Gravité
          <select name="severity" defaultValue={severity ?? ""}>
            <option value="">Toutes</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" name="mine" value="true" defaultChecked={mine === "true"} />
          Attribuées à moi
        </label>
        <button type="submit">Filtrer</button>
      </form>
      {items.length === 0 ? (
        <Empty>Aucune alerte.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Règle</th>
              <th>Gravité</th>
              <th>Client</th>
              <th>Transfert</th>
              <th>État</th>
              <th>Attribuée à</th>
              <th>Créée le</th>
            </tr>
          </thead>
          <tbody>
            {items.map((alert) => (
              <tr key={alert.id}>
                <td>
                  <Link href={`/aml/alertes/${alert.id}`}>{alert.rule.code}</Link>
                  {alert.rule.blocksTransfer && <span className="badge critical">bloquante</span>}
                </td>
                <td>
                  <Badge value={alert.severity} labels={SEVERITY_LABELS} />
                </td>
                <td>{alert.customerNumber}</td>
                <td>{alert.transferReference ?? "—"}</td>
                <td>
                  <Badge value={alert.status} labels={ALERT_STATUS_LABELS} />
                </td>
                <td>{alert.assignee?.name ?? "—"}</td>
                <td>{formatDateTime(alert.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
