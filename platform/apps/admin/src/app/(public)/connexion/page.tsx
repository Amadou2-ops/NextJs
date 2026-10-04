import type { Metadata } from "next";
import type { ReactNode } from "react";

import { safeNextPath } from "@/server/session";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const params = await searchParams;
  const suite = typeof params["suite"] === "string" ? safeNextPath(params["suite"]) : null;
  return (
    <section className="auth">
      <h1>Back-office TransfertPlus</h1>
      <p className="muted">Accès réservé au personnel, depuis le réseau de l&apos;entreprise, avec une clé de sécurité matérielle enregistrée.</p>
      <LoginForm suite={suite} />
    </section>
  );
}
