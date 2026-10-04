import type { Metadata } from "next";
import type { ReactNode } from "react";

import type { SessionSummary } from "@/lib/types";
import { sessionApi } from "@/server/context";

import { ClosurePanel, PasskeyPanel, SessionsPanel, TotpPanel } from "./SecurityPanels";

export const metadata: Metadata = { title: "Sécurité" };

export default async function SecurityPage(): Promise<ReactNode> {
  const { sessions } = await sessionApi<{ sessions: SessionSummary[] }>("/securite", { path: "/v1/auth/sessions" });
  return (
    <>
      <h1>Sécurité du compte</h1>
      <div className="grid">
        <TotpPanel />
        <PasskeyPanel />
      </div>
      <SessionsPanel sessions={sessions} />
      <ClosurePanel />
    </>
  );
}
