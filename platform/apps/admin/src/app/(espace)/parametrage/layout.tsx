import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

import { NoAccess } from "@/components/ui";
import { can, currentAdmin } from "@/server/admin";

/** Paramétrage : consultation (configuration:read) ; chaque modification passe par la double validation. */
const TABS: readonly { readonly href: Route; readonly label: string }[] = [
  { href: "/parametrage", label: "Vue d'ensemble" },
  { href: "/parametrage/marges", label: "Marges de change" },
  { href: "/parametrage/frais", label: "Frais" },
  { href: "/parametrage/corridors", label: "Corridors" },
  { href: "/parametrage/encaissement", label: "Encaissement" },
  { href: "/parametrage/prestataires", label: "Prestataires" },
  { href: "/parametrage/pays", label: "Pays" },
  { href: "/parametrage/apercu", label: "Aperçu du prix" },
];

export default async function ConfigurationLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "configuration:read")) return <NoAccess permission="configuration:read" />;
  return (
    <>
      <nav className="tabs" aria-label="Sections du paramétrage">
        {TABS.map((tab) => (
          <Link key={tab.href} href={tab.href}>
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
