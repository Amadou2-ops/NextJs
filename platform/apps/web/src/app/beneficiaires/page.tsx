import type { Metadata } from "next";
import type { ReactNode } from "react";

import type { Recipient } from "@/lib/types";
import { sessionApi } from "@/server/context";

import { RecipientManager } from "./RecipientManager";

export const metadata: Metadata = { title: "Bénéficiaires" };

export default async function RecipientsPage(): Promise<ReactNode> {
  const { recipients } = await sessionApi<{ recipients: Recipient[] }>("/beneficiaires", { path: "/v1/recipients" });
  return (
    <>
      <h1>Bénéficiaires</h1>
      <p className="muted">Les coordonnées sont chiffrées et ne sont plus modifiables après l&apos;enregistrement : en cas d&apos;erreur, retirez le bénéficiaire et recréez-le.</p>
      <RecipientManager recipients={recipients} />
    </>
  );
}
