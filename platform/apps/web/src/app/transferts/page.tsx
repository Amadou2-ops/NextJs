import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { TransferList } from "@/components/TransferList";
import type { Transfer } from "@/lib/types";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Mes transferts" };

export default async function TransfersPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const params = await searchParams;
  const before = typeof params["avant"] === "string" && !Number.isNaN(Date.parse(params["avant"])) ? params["avant"] : undefined;
  const page = await sessionApi<{ transfers: Transfer[]; nextCursor: string | null }>("/transferts", {
    path: "/v1/transfers",
    query: { limit: "20", ...(before === undefined ? {} : { before }) },
  });
  return (
    <>
      <h1>Mes transferts</h1>
      <section className="card">
        <TransferList transfers={page.transfers} />
        {page.nextCursor !== null && (
          <p>
            <Link href={`/transferts?avant=${encodeURIComponent(page.nextCursor)}`}>Transferts plus anciens</Link>
          </p>
        )}
      </section>
    </>
  );
}
