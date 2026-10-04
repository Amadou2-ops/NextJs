import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { webConfig } from "@/server/env";
import { PENDING_COOKIE, unsealPending } from "@/server/session";

import { CodeForm } from "./CodeForm";

export const metadata: Metadata = { title: "Vérification de connexion" };

export default async function LoginVerificationPage(): Promise<ReactNode> {
  const pending = await unsealPending(webConfig().sessionKeys, (await cookies()).get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "login") {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1>Vérification expirée</h1>
        <p>
          Cette étape a expiré. <Link href="/connexion">Reconnectez-vous</Link>.
        </p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Vérification de connexion</h1>
      <p className="muted">
        {pending.method === "totp" ? "Saisissez le code affiché par votre application d'authentification." : "Saisissez le code reçu par SMS."}
      </p>
      <CodeForm />
    </div>
  );
}
