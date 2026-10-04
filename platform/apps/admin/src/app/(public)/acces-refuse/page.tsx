import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { logoutAction } from "@/app/deconnexion/actions";

export const metadata: Metadata = { title: "Accès refusé" };

/**
 * Atteinte quand l'API refuse l'accès : permission retirée, ou adresse IP
 * hors des plages autorisées du membre (réseau de l'entreprise exigé).
 */
export default function AccessDeniedPage(): ReactNode {
  return (
    <section className="auth">
      <h1>Accès refusé</h1>
      <p>Votre compte ne dispose pas de l&apos;habilitation requise, ou vous n&apos;êtes pas connecté depuis un réseau autorisé (VPN de l&apos;entreprise).</p>
      <p className="muted">Chaque refus est consigné au journal d&apos;audit. Contactez un administrateur si vous pensez qu&apos;il s&apos;agit d&apos;une erreur.</p>
      <div className="row">
        <Link className="button secondary" href="/">
          Réessayer
        </Link>
        <form action={logoutAction}>
          <button type="submit">Se déconnecter</button>
        </form>
      </div>
    </section>
  );
}
