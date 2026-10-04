import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Empty, NoAccess } from "@/components/ui";
import { formatDateTime, ROLE_LABELS, STAFF_STATUS_LABELS } from "@/lib/format";
import type { StaffMember, StaffStatus } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { oneOf, single, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Personnel" };

const STATUSES: readonly StaffStatus[] = ["active", "invited", "suspended", "disabled"];

export default async function StaffPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "admins:manage")) return <NoAccess permission="admins:manage" />;
  const status = oneOf(single((await searchParams)["status"]), STATUSES);
  const { items } = await sessionApi<{ items: StaffMember[] }>("/personnel", { path: "/v1/admin/staff", query: { status } });

  return (
    <>
      <div className="row">
        <h1>Personnel</h1>
        <Link className="button" href="/personnel/inviter">
          Inviter un membre
        </Link>
      </div>
      <nav className="tabs" aria-label="Filtrer par état">
        <Link href="/personnel" aria-current={status === undefined ? "page" : undefined}>
          Tous
        </Link>
        {STATUSES.map((value) => (
          <Link key={value} href={withQuery("/personnel", { status: value })} aria-current={value === status ? "page" : undefined}>
            {STAFF_STATUS_LABELS[value]}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <Empty>Aucun membre.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>E-mail</th>
              <th>Rôles</th>
              <th>Clés</th>
              <th>État</th>
              <th>Dernière connexion</th>
            </tr>
          </thead>
          <tbody>
            {items.map((member) => (
              <tr key={member.id}>
                <td>
                  <Link href={`/personnel/${member.id}`}>{member.fullName}</Link>
                </td>
                <td>{member.email}</td>
                <td>{member.roles.map((role) => ROLE_LABELS[role]).join(", ") || "—"}</td>
                <td>{member.securityKeys}</td>
                <td>
                  <Badge value={member.status} labels={STAFF_STATUS_LABELS} />
                </td>
                <td>{formatDateTime(member.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
