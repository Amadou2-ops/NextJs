import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { webConfig } from "@/server/env";
import { PENDING_COOKIE, unsealPending } from "@/server/session";

import { NewPasswordForm } from "./NewPasswordForm";

export const metadata: Metadata = { title: "Nouveau mot de passe" };

export default async function NewPasswordPage(): Promise<ReactNode> {
  const pending = await unsealPending(webConfig().sessionKeys, (await cookies()).get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "password_reset") {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1>Étape expirée</h1>
        <p>
          <Link href="/mot-de-passe-oublie">Demandez un nouveau code</Link>.
        </p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Nouveau mot de passe</h1>
      <p className="muted">Saisissez le code envoyé au {pending.phone.replace(/\d(?=\d{2})/g, "•")}. Toutes vos sessions seront fermées.</p>
      <NewPasswordForm />
      <p>
        <Link href="/mot-de-passe-oublie">Demander un nouveau code</Link>
      </p>
    </div>
  );
}
