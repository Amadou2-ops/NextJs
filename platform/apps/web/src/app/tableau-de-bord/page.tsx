import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { TransferList } from "@/components/TransferList";
import { formatMoney } from "@/lib/format";
import type { KycOverview, Transfer, Wallet } from "@/lib/types";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Tableau de bord" };

const TIER_LABELS: Readonly<Record<KycOverview["tier"], string>> = {
  tier_0: "Identité non vérifiée",
  tier_1: "Identité vérifiée (niveau 1)",
  tier_2: "Identité vérifiée (niveau 2)",
  tier_3: "Vigilance renforcée (niveau 3)",
};

export default async function DashboardPage(): Promise<ReactNode> {
  const path = "/tableau-de-bord";
  const [wallets, transfers, kyc] = await Promise.all([
    sessionApi<{ wallets: Wallet[] }>(path, { path: "/v1/wallets" }),
    sessionApi<{ transfers: Transfer[] }>(path, { path: "/v1/transfers", query: { limit: "5" } }),
    sessionApi<KycOverview>(path, { path: "/v1/kyc" }),
  ]);
  return (
    <>
      <h1>Tableau de bord</h1>
      {kyc.tier === "tier_0" && (
        <p className="alert info">
          Vérifiez votre identité pour envoyer de l&apos;argent. <Link href="/verification">Vérifier mon identité</Link>
        </p>
      )}
      <div className="grid">
        <section className="card">
          <h2>Envoyer de l&apos;argent</h2>
          <p className="muted">Taux et frais garantis par devis avant confirmation.</p>
          <Link className="button" href="/envoyer">
            Nouveau transfert
          </Link>
        </section>
        <section className="card">
          <h2>Mon identité</h2>
          <p>{TIER_LABELS[kyc.tier]}</p>
          <p className="muted">Plafond par transfert : {formatMoney(kyc.limits.singleTransferMax)}</p>
          {kyc.nextTier !== null && <Link href="/verification">Relever mes plafonds</Link>}
        </section>
        {wallets.wallets.map((wallet) => (
          <section className="card" key={wallet.currency}>
            <h2>Portefeuille {wallet.currency}</h2>
            <p className="amount">{formatMoney(wallet.available)}</p>
            {wallet.held.amount !== "0" && <p className="muted">Réservé : {formatMoney(wallet.held)}</p>}
            <Link href={`/portefeuille/${wallet.currency}`}>Voir le relevé</Link>
          </section>
        ))}
      </div>
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Derniers transferts</h2>
          <Link href="/transferts">Tout voir</Link>
        </div>
        <TransferList transfers={transfers.transfers} />
      </section>
    </>
  );
}
