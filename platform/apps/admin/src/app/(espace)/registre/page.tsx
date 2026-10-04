import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Badge, Details, Json, NoAccess } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { LedgerIntegrity, TrialBalance } from "@/lib/types";
import type { SearchParams } from "@/lib/url";
import { single, UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Registre" };

const RECONCILIATION_LABELS: Readonly<Record<string, string>> = { healthy: "Sain", anomalies: "Anomalies", error: "En erreur", running: "En cours" };

/** Balance générale, intégrité de la chaîne de hachage et accès aux comptes et journaux. */
export default async function LedgerPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "ledger:read")) return <NoAccess permission="ledger:read" />;
  const params = await searchParams;
  const account = single(params["compte"])?.trim();
  const journal = single(params["journal"])?.trim();
  if (account !== undefined && UUID_PATTERN.test(account)) redirect(`/registre/comptes/${account.toLowerCase()}`);
  if (journal !== undefined && UUID_PATTERN.test(journal)) redirect(`/registre/journaux/${journal.toLowerCase()}`);
  const invalidLookup = account !== undefined || journal !== undefined;

  const [balance, integrity] = await Promise.all([
    sessionApi<TrialBalance>("/registre", { path: "/v1/admin/ledger/trial-balance" }),
    sessionApi<LedgerIntegrity>("/registre", { path: "/v1/admin/ledger/integrity" }),
  ]);
  const reconciliation = integrity.lastReconciliation;

  return (
    <>
      <h1>Registre en partie double</h1>
      {invalidLookup && <p className="alert error">Identifiant invalide.</p>}
      <div className="grid">
        <form className="card stack" method="get" action="/registre">
          <label>
            Compte (identifiant)
            <input name="compte" maxLength={36} autoComplete="off" required />
          </label>
          <button type="submit" className="secondary">
            Ouvrir le compte
          </button>
        </form>
        <form className="card stack" method="get" action="/registre">
          <label>
            Journal (identifiant)
            <input name="journal" maxLength={36} autoComplete="off" required />
          </label>
          <button type="submit" className="secondary">
            Ouvrir le journal
          </button>
        </form>
        {can(admin, "ledger:adjust") && (
          <div className="card stack">
            <p>Correction d&apos;une erreur comptable par un journal équilibré, soumis à double validation.</p>
            <Link className="button" href="/registre/ajustement">
              Demander un ajustement
            </Link>
          </div>
        )}
      </div>

      <h2>Balance générale</h2>
      <table>
        <thead>
          <tr>
            <th>Devise</th>
            <th className="number">Total des débits</th>
            <th className="number">Total des crédits</th>
            <th className="number">Soldes débiteurs</th>
            <th className="number">Soldes créditeurs</th>
            <th>Équilibre</th>
          </tr>
        </thead>
        <tbody>
          {balance.currencies.map((row) => (
            <tr key={row.currency}>
              <td>{row.currency}</td>
              <td className="number amount">{formatMoney(row.totalDebits, row.currency)}</td>
              <td className="number amount">{formatMoney(row.totalCredits, row.currency)}</td>
              <td className="number amount">{formatMoney(row.debitNormalBalances, row.currency)}</td>
              <td className="number amount">{formatMoney(row.creditNormalBalances, row.currency)}</td>
              <td>{row.balanced ? <Badge value="active" labels={{ active: "Équilibré" }} /> : <Badge value="critical" labels={{ critical: "DÉSÉQUILIBRE" }} />}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Intégrité</h2>
      <div className="card">
        <Details
          items={[
            ["Tête de chaîne", integrity.chainHead === null ? "—" : <span key="h">n° {integrity.chainHead.sequence} · <code>{integrity.chainHead.hash}</code></span>],
            ["Dernier rapprochement", reconciliation === null ? "Jamais" : <Badge key="r" value={reconciliation.status} labels={RECONCILIATION_LABELS} tone={reconciliation.status === "healthy" ? "active" : "critical"} />],
            ["Terminé le", formatDateTime(reconciliation?.finishedAt ?? null)],
            ["Séquences vérifiées", reconciliation === null ? "—" : `${reconciliation.verifiedFromSequence ?? "?"} → ${reconciliation.verifiedToSequence ?? "?"}`],
            [
              "Dernier ancrage horodaté (RFC 3161)",
              integrity.lastAnchor === null ? "Aucun" : `n° ${integrity.lastAnchor.sequence} · ${integrity.lastAnchor.target} · ${formatDateTime(integrity.lastAnchor.anchoredAt)}`,
            ],
          ]}
        />
        {reconciliation !== null && reconciliation.problems.length > 0 && (
          <>
            <p className="alert error">Le dernier rapprochement a relevé des anomalies :</p>
            <Json value={reconciliation.problems} />
          </>
        )}
      </div>
    </>
  );
}
