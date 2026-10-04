import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { webConfig } from "@/server/env";
import { PENDING_COOKIE, unsealPending } from "@/server/session";

import { ConfirmationForm } from "./ConfirmationForm";

export const metadata: Metadata = { title: "Confirmer votre numéro" };

export default async function RegistrationConfirmationPage(): Promise<ReactNode> {
  const pending = await unsealPending(webConfig().sessionKeys, (await cookies()).get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "registration") {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1>Étape expirée</h1>
        <p>
          <Link href="/inscription">Recommencez l&apos;inscription</Link>.
        </p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Confirmer votre numéro</h1>
      <p className="muted">Nous avons envoyé un code au {pending.phone.replace(/\d(?=\d{2})/g, "•")}.</p>
      <ConfirmationForm />
    </div>
  );
}
