import type { Metadata } from "next";
import type { ReactNode } from "react";

import type { Recipient, Wallet } from "@/lib/types";
import { sessionApi } from "@/server/context";

import { SendFlow } from "./SendFlow";

export const metadata: Metadata = { title: "Envoyer de l'argent" };

export default async function SendPage(): Promise<ReactNode> {
  const [recipients, wallets] = await Promise.all([
    sessionApi<{ recipients: Recipient[] }>("/envoyer", { path: "/v1/recipients" }),
    sessionApi<{ wallets: Wallet[] }>("/envoyer", { path: "/v1/wallets" }),
  ]);
  const currencies = [...new Set([...wallets.wallets.map((wallet) => wallet.currency), "EUR", "GBP", "USD", "CAD"])];
  return (
    <>
      <h1>Envoyer de l&apos;argent</h1>
      <SendFlow recipients={recipients.recipients} sourceCurrencies={currencies} />
    </>
  );
}
