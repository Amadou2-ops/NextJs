import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { readSession } from "@/server/context";

import { logoutAction } from "./deconnexion/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TransfertPlus — envoyez de l'argent en Afrique", template: "%s · TransfertPlus" },
  description: "Transferts d'argent internationaux vers le mobile money, les comptes bancaires et le retrait en espèces, au taux annoncé.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b6e4f" };

export default async function RootLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  const session = await readSession();
  return (
    <html lang="fr">
      <body>
        <a className="sr-only" href="#contenu">
          Aller au contenu
        </a>
        <header className="site-header">
          <nav aria-label="Navigation principale">
            <Link className="brand" href="/">
              TransfertPlus
            </Link>
            {session === null ? (
              <>
                <Link href="/connexion">Se connecter</Link>
                <Link className="button" href="/inscription">
                  Créer un compte
                </Link>
              </>
            ) : (
              <>
                <Link href="/tableau-de-bord">Tableau de bord</Link>
                <Link href="/envoyer">Envoyer</Link>
                <Link href="/transferts">Transferts</Link>
                <Link href="/beneficiaires">Bénéficiaires</Link>
                <Link href="/verification">Identité</Link>
                <Link href="/securite">Sécurité</Link>
                <form action={logoutAction}>
                  <button className="secondary" type="submit">
                    Se déconnecter
                  </button>
                </form>
              </>
            )}
          </nav>
        </header>
        <main id="contenu">{children}</main>
      </body>
    </html>
  );
}
