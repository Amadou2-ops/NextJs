import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, Json, NextPage, NoAccess } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { AuditEvent, AuditIntegrity, Page } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { single, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Journal d'audit" };

/** Filtres bornés comme côté API ; une valeur hors format est ignorée et signalée. */
function filter(value: string | undefined, pattern: RegExp): { readonly value: string | undefined; readonly invalid: boolean } {
  if (value === undefined) return { value: undefined, invalid: false };
  const trimmed = value.trim();
  return pattern.test(trimmed) ? { value: trimmed, invalid: false } : { value: undefined, invalid: true };
}

export default async function AuditPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "audit:read")) return <NoAccess permission="audit:read" />;
  const params = await searchParams;
  const actorId = filter(single(params["actorId"]), /^.{1,200}$/);
  const targetType = filter(single(params["targetType"]), /^[a-z_]{2,50}$/);
  const targetId = filter(single(params["targetId"]), /^.{1,200}$/);
  const action = filter(single(params["action"]), /^[a-z_]+(\.[a-z_]+)+$/);
  const before = filter(single(params["before"]), /^[1-9][0-9]{0,18}$/);
  const invalid = [actorId, targetType, targetId, action, before].some((item) => item.invalid);

  const query = { actorId: actorId.value, targetType: targetType.value, targetId: targetId.value, action: action.value };
  const [page, integrity] = await Promise.all([
    sessionApi<Page<AuditEvent>>("/audit", { path: "/v1/admin/audit/events", query: { ...query, before: before.value, limit: "50" } }),
    sessionApi<AuditIntegrity>("/audit", { path: "/v1/admin/audit/integrity" }),
  ]);

  return (
    <>
      <h1>Journal d&apos;audit</h1>
      <div className={`alert ${integrity.intact ? "success" : "error"}`} role="status">
        {integrity.intact
          ? `Chaîne de hachage intacte jusqu'à l'événement n° ${integrity.lastEventId ?? "—"}.`
          : `ANOMALIE : ${integrity.problems.length.toString()} rupture(s) de la chaîne de hachage détectée(s).`}
      </div>
      {!integrity.intact && <Json value={integrity.problems} />}

      <form className="filters" method="get" action="/audit">
        <label>
          Auteur (identifiant)
          <input name="actorId" defaultValue={actorId.value} maxLength={200} autoComplete="off" />
        </label>
        <label>
          Action
          <input name="action" defaultValue={action.value} placeholder="approval.executed" maxLength={100} autoComplete="off" />
        </label>
        <label>
          Type de cible
          <input name="targetType" defaultValue={targetType.value} placeholder="transfer" maxLength={50} autoComplete="off" />
        </label>
        <label>
          Cible (identifiant)
          <input name="targetId" defaultValue={targetId.value} maxLength={200} autoComplete="off" />
        </label>
        <button type="submit">Filtrer</button>
      </form>
      {invalid && <p className="alert error">Un filtre au format invalide a été ignoré.</p>}

      {page.items.length === 0 ? (
        <Empty>Aucun événement.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Auteur</th>
              <th>Action</th>
              <th>Cible</th>
              <th>Adresse IP</th>
              <th>Détails</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((event) => (
              <tr key={event.id}>
                <td>{event.id}</td>
                <td>{formatDateTime(event.occurredAt)}</td>
                <td>
                  <Badge value={event.actor.type} tone="neutral" />
                  <br />
                  <code>{event.actor.id ?? "—"}</code>
                </td>
                <td>
                  <code>{event.action}</code>
                </td>
                <td>{event.target === null ? "—" : <code>{`${event.target.type} ${event.target.id ?? ""}`}</code>}</td>
                <td>{event.ipAddress ?? "—"}</td>
                <td>
                  <details>
                    <summary>Voir</summary>
                    <Json value={{ requestId: event.requestId, metadata: event.metadata, hash: event.hash }} />
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NextPage href={page.nextCursor === null ? null : withQuery("/audit", { ...query, before: page.nextCursor })} />
    </>
  );
}
