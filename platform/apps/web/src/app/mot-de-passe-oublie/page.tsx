import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { StartResetForm } from "./StartResetForm";

export const metadata: Metadata = { title: "Mot de passe oublié" };

export default function ForgottenPasswordPage(): ReactNode {
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Mot de passe oublié</h1>
      <p className="muted">Si un compte correspond à ce numéro, vous recevrez un code par SMS.</p>
      <StartResetForm />
      <p>
        <Link href="/connexion">Retour à la connexion</Link>
      </p>
    </div>
  );
}
