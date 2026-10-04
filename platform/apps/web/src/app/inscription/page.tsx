import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { RegistrationForm } from "./RegistrationForm";

export const metadata: Metadata = { title: "Créer un compte" };

export default function RegistrationPage(): ReactNode {
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Créer un compte</h1>
      <p className="muted">Un code de confirmation vous sera envoyé par SMS.</p>
      <RegistrationForm />
      <p>
        Déjà inscrit ? <Link href="/connexion">Se connecter</Link>
      </p>
    </div>
  );
}
