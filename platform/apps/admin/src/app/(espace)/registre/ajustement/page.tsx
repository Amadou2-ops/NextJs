import type { Metadata } from "next";
import type { ReactNode } from "react";

import { NoAccess } from "@/components/ui";
import type { TrialBalance } from "@/lib/types";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { AdjustmentForm } from "./AdjustmentForm";

export const metadata: Metadata = { title: "Ajustement comptable" };

export default async function AdjustmentPage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "ledger:adjust")) return <NoAccess permission="ledger:adjust" />;
  // Devises effectivement tenues au registre.
  const balance = await sessionApi<TrialBalance>("/registre/ajustement", { path: "/v1/admin/ledger/trial-balance" });
  return (
    <>
      <h1>Demande d&apos;ajustement comptable</h1>
      <p className="muted">
        Le registre est immuable : un ajustement est un nouveau journal équilibré (débits = crédits dans chaque devise), exécuté seulement après approbation par un second membre habilité.
      </p>
      <AdjustmentForm currencies={balance.currencies.map((row) => row.currency)} />
    </>
  );
}
