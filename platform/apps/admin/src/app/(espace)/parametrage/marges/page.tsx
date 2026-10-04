import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty } from "@/components/ui";
import type { PricingRule } from "@/lib/configuration";
import { formatBps, RULE_STATE_LABELS, scope } from "@/lib/configuration";
import { formatDateTime } from "@/lib/format";
import type { SearchParams } from "@/lib/url";
import { single } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestPricingClosureAction, requestPricingRuleAction } from "../actions";
import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Marges de change" };

function ruleLabel(rule: PricingRule): string {
  return `${scope(rule.sourceCurrency, "toutes")} → ${scope(rule.destinationCurrency, "toutes")} · ${formatBps(rule.marginBps)} · priorité ${rule.priority.toString()} (${RULE_STATE_LABELS[rule.state]})`;
}

export default async function PricingRulesPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const all = single((await searchParams)["etat"]) === "tout";
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PricingRule[] }>("/parametrage/marges", { path: "/v1/admin/configuration/pricing-rules", query: { state: all ? "all" : "current" } });
  const open = items.filter((rule) => rule.state !== "ended");
  const options = [{ value: "", label: "Aucune" }, ...open.map((rule) => ({ value: rule.id, label: ruleLabel(rule) }))];

  return (
    <>
      <h1>Marges de change</h1>
      <p className="muted">
        Taux client = taux moyen × (1 − marge). La règle la plus prioritaire, puis la plus précise (paire de devises plutôt que « toutes »), s&apos;applique.
      </p>
      <nav className="tabs" aria-label="Filtrer les marges">
        <Link href="/parametrage/marges" aria-current={all ? undefined : "page"}>
          En vigueur et programmées
        </Link>
        <Link href="/parametrage/marges?etat=tout" aria-current={all ? "page" : undefined}>
          Historique
        </Link>
      </nav>
      {items.length === 0 ? (
        <Empty>Aucune marge : aucun devis entre devises différentes n&apos;est possible.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Devise d&apos;envoi</th>
              <th>Devise reçue</th>
              <th className="number">Marge</th>
              <th className="number">Priorité</th>
              <th>Début</th>
              <th>Fin</th>
              <th>État</th>
              <th>Demandée par</th>
            </tr>
          </thead>
          <tbody>
            {items.map((rule) => (
              <tr key={rule.id}>
                <td>{scope(rule.sourceCurrency, "Toutes")}</td>
                <td>{scope(rule.destinationCurrency, "Toutes")}</td>
                <td className="number">{formatBps(rule.marginBps)}</td>
                <td className="number">{rule.priority}</td>
                <td>{formatDateTime(rule.validFrom)}</td>
                <td>{formatDateTime(rule.validTo)}</td>
                <td>
                  <Badge value={rule.state} labels={RULE_STATE_LABELS} /> <PendingLink id={rule.pendingRequestId} />
                </td>
                <td>{rule.createdBy?.name ?? "Exploitation"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(admin, "pricing:manage") && (
        <div className="grid">
          <ActionForm
            action={requestPricingRuleAction}
            title="Nouvelle marge"
            description="Laisser une devise vide pour « toutes ». Une marge remplacée prend fin à la date d'effet de la nouvelle."
            fourEyes={requiresFourEyes(admin, "pricing:manage")}
            fields={[
              { name: "sourceCurrency", label: "Devise d'envoi", kind: "text", required: false, maxLength: 3, placeholder: "EUR" },
              { name: "destinationCurrency", label: "Devise reçue", kind: "text", required: false, maxLength: 3, placeholder: "XOF" },
              { name: "margin", label: "Marge (%)", kind: "text", maxLength: 5, placeholder: "1,5", help: "Entre 0 et 15 %, au centième près." },
              { name: "priority", label: "Priorité", kind: "text", maxLength: 6, defaultValue: "0" },
              { name: "validFrom", label: "Date d'effet (heure de Paris)", kind: "datetime", required: false, help: "Vide : dès l'approbation. Au plus 90 jours." },
              { name: "validTo", label: "Fin (heure de Paris)", kind: "datetime", required: false },
              { name: "replacesRuleId", label: "Remplace la marge", kind: "select", required: false, options },
              { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
            ]}
            submitLabel="Demander la nouvelle marge"
          />
          {open.length > 0 && (
            <ActionForm
              action={requestPricingClosureAction}
              title="Clore une marge"
              description="Une clôture avance la fin de validité ; elle ne la repousse jamais."
              fourEyes={requiresFourEyes(admin, "pricing:manage")}
              tone="danger"
              fields={[
                { name: "id", label: "Marge", kind: "select", options: open.map((rule) => ({ value: rule.id, label: ruleLabel(rule) })) },
                { name: "validTo", label: "Fin (heure de Paris)", kind: "datetime", required: false, help: "Vide : dès l'approbation." },
                { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
              ]}
              submitLabel="Demander la clôture"
            />
          )}
        </div>
      )}
    </>
  );
}
