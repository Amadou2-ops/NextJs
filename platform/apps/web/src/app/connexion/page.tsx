import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { safeNextPath } from "@/server/session";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const params = await searchParams;
  const suite = safeNextPath(typeof params["suite"] === "string" ? params["suite"] : null);
  const reset = params["reinitialise"] === "1";
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Connexion</h1>
      {reset && (
        <p className="alert success" role="status">
          Votre mot de passe a été modifié. Connectez-vous avec le nouveau.
        </p>
      )}
      <LoginForm suite={suite} />
      <p>
        <Link href="/mot-de-passe-oublie">Mot de passe oublié ?</Link>
      </p>
      <p>
        Pas encore de compte ? <Link href="/inscription">Créer un compte</Link>
      </p>
    </div>
  );
}
