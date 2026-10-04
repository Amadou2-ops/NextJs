import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

import { ROLE_LABELS } from "@/lib/format";
import type { Permission } from "@/lib/types";
import { can, currentAdmin } from "@/server/admin";

import { logoutAction } from "../deconnexion/actions";

/** Navigation filtrée par permission (l'API revérifie chaque accès). */
const NAVIGATION: readonly { readonly href: Route; readonly label: string; readonly permission: Permission | null }[] = [
  { href: "/", label: "Accueil", permission: null },
  { href: "/approbations", label: "Approbations", permission: "approvals:decide" },
  { href: "/clients", label: "Clients", permission: "customers:read" },
  { href: "/transferts", label: "Transferts", permission: "transfers:read" },
  { href: "/kyc", label: "Identité (KYC)", permission: "kyc:read" },
  { href: "/aml/alertes", label: "Alertes LCB-FT", permission: "aml:alerts:read" },
  { href: "/aml/dossiers", label: "Dossiers", permission: "aml:alerts:read" },
  { href: "/registre", label: "Registre", permission: "ledger:read" },
  { href: "/parametrage", label: "Paramétrage", permission: "configuration:read" },
  { href: "/personnel", label: "Personnel", permission: "admins:manage" },
  { href: "/audit", label: "Audit", permission: "audit:read" },
];

export default async function StaffLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  const admin = await currentAdmin();
  return (
    <div className="shell">
      <a className="sr-only" href="#contenu">
        Aller au contenu
      </a>
      <aside className="sidebar">
        <p className="brand">TransfertPlus · Back-office</p>
        <nav aria-label="Navigation du back-office">
          <ul>
            {NAVIGATION.filter((item) => item.permission === null || can(admin, item.permission)).map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="identity">
          <p>
            <strong>{admin.fullName}</strong>
            <br />
            <span className="small">{admin.roles.map((role) => ROLE_LABELS[role]).join(", ")}</span>
          </p>
          <form action={logoutAction}>
            <button className="secondary small-button" type="submit">
              Se déconnecter
            </button>
          </form>
        </div>
      </aside>
      <main id="contenu">{children}</main>
    </div>
  );
}
