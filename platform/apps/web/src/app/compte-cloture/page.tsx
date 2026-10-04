import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Compte clôturé" };

export default function ClosedAccountPage(): ReactNode {
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h1>Votre compte est clôturé</h1>
      <p>Toutes vos sessions ont été fermées. Merci d&apos;avoir utilisé TransfertPlus.</p>
      <p className="muted">
        Vos données sont conservées pour la durée imposée par la réglementation sur la lutte contre le blanchiment, puis supprimées. Pour toute question, contactez notre service client.
      </p>
      <p>
        <Link href="/">Retour à l&apos;accueil</Link>
      </p>
    </div>
  );
}
