import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { safeNextPath } from "@/server/session";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const params = await searchParams;
  const suite = safeNextPath(typeof params["suite"] === "string" ? params["suite"] : null);
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Connexion</h1>
      <LoginForm suite={suite} />
      <p>
        Pas encore de compte ? <Link href="/inscription">Créer un compte</Link>
      </p>
    </div>
  );
}
