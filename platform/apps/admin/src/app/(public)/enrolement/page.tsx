import type { Metadata } from "next";
import type { ReactNode } from "react";

import { EnrollmentForm } from "./EnrollmentForm";

export const metadata: Metadata = { title: "Activation du compte" };

export default function EnrollmentPage(): ReactNode {
  return (
    <section className="auth">
      <h1>Activation de votre compte</h1>
      <p className="muted">Choisissez un mot de passe robuste et enregistrez votre clé de sécurité. Le lien d&apos;invitation est à usage unique.</p>
      <EnrollmentForm />
    </section>
  );
}
