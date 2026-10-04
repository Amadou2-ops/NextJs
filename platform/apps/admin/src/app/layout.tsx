import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Back-office", template: "%s · Back-office TransfertPlus" },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1d2939" };

/**
 * Rendu toujours dynamique : chaque page reçoit le nonce CSP de sa requête
 * (une page pré-rendue ne pourrait pas porter de nonce et ses scripts
 * seraient bloqués), et rien n'est mis en cache côté serveur.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  await connection();
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
