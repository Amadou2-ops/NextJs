import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { formatDateTime, formatMoney } from "@/lib/format";
import type { StatementEntry } from "@/lib/types";
import { ApiError } from "@/server/api";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Relevé du portefeuille" };

export default async function StatementPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly currency: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { currency } = await params;
  if (!/^[A-Z]{3}$/.test(currency)) notFound();
  const query = await searchParams;
  const before = typeof query["avant"] === "string" && /^[1-9][0-9]{0,17}$/.test(query["avant"]) ? query["avant"] : undefined;
  let statement: { entries: StatementEntry[]; nextCursor: string | null };
  try {
    statement = await sessionApi(`/portefeuille/${currency}`, { path: `/v1/wallets/${currency}/statement`, query: { limit: "50", ...(before === undefined ? {} : { before }) } });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <>
      <h1>Relevé {currency}</h1>
      <section className="card">
        {statement.entries.length === 0 ? (
          <p className="muted">Aucune opération.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Opération</th>
                <th scope="col">Montant</th>
                <th scope="col">Solde</th>
              </tr>
            </thead>
            <tbody>
              {statement.entries.map((entry) => (
                <tr key={entry.entryId}>
                  <td>{formatDateTime(entry.effectiveAt)}</td>
                  <td>
                    {entry.description}
                    {entry.isReversal && <span className="badge"> annulation</span>}
                  </td>
                  <td className="amount">
                    {entry.direction === "in" ? "+" : "−"}
                    {formatMoney(entry.amount)}
                  </td>
                  <td className="amount">{formatMoney(entry.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {statement.nextCursor !== null && (
          <p>
            <Link href={`/portefeuille/${currency}?avant=${statement.nextCursor}`}>Opérations plus anciennes</Link>
          </p>
        )}
      </section>
    </>
  );
}
