import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty } from "@/components/ui";
import type { FeeSchedule } from "@/lib/configuration";
import { formatBps, FUNDING_METHOD_LABELS, FUNDING_METHODS, PAYOUT_METHOD_LABELS, PAYOUT_METHODS, RULE_STATE_LABELS, scope } from "@/lib/configuration";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { SearchParams } from "@/lib/url";
import { single } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestFeeClosureAction, requestFeeScheduleAction } from "../actions";
import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Barèmes de frais" };

function feeText(schedule: FeeSchedule): string {
  const parts = [formatMoney(schedule.fixedFee, schedule.sourceCurrency)];
  if (schedule.percentageBps > 0) parts.push(formatBps(schedule.percentageBps));
  return parts.join(" + ");
}

function scheduleLabel(schedule: FeeSchedule): string {
  return `${schedule.sourceCurrency} · ${scope(schedule.sourceCountry)} → ${scope(schedule.destinationCountry)} · ${feeText(schedule)} · priorité ${schedule.priority.toString()} (${RULE_STATE_LABELS[schedule.state]})`;
}

export default async function FeeSchedulesPage({ searchParams }: { readonly searchParams: SearchParams }): Promise<ReactNode> {
  const all = single((await searchParams)["etat"]) === "tout";
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: FeeSchedule[] }>("/parametrage/frais", { path: "/v1/admin/configuration/fee-schedules", query: { state: all ? "all" : "current" } });
  const open = items.filter((schedule) => schedule.state !== "ended");
  const any = { value: "", label: "Tous" };
  const fourEyes = requiresFourEyes(admin, "pricing:manage");

  return (
    <>
      <h1>Barèmes de frais</h1>
      <p className="muted">
        Frais = fixe + pourcentage du montant envoyé (arrondi au supérieur), bornés par le minimum et le plafond, dans la devise d&apos;envoi. Le barème le
        plus prioritaire, puis le plus précis, s&apos;applique.
      </p>
      <nav className="tabs" aria-label="Filtrer les barèmes">
        <Link href="/parametrage/frais" aria-current={all ? undefined : "page"}>
          En vigueur et programmés
        </Link>
        <Link href="/parametrage/frais?etat=tout" aria-current={all ? "page" : undefined}>
          Historique
        </Link>
      </nav>
      {items.length === 0 ? (
        <Empty>Aucun barème : aucun devis n&apos;est possible.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Devise</th>
              <th>Origine → destination</th>
              <th>Réception / paiement</th>
              <th>Frais</th>
              <th className="number">Minimum</th>
              <th className="number">Plafond</th>
              <th className="number">Priorité</th>
              <th>Validité</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {items.map((schedule) => (
              <tr key={schedule.id}>
                <td>{schedule.sourceCurrency}</td>
                <td>
                  {scope(schedule.sourceCountry)} → {scope(schedule.destinationCountry)}
                  {schedule.destinationCurrency !== null && ` (${schedule.destinationCurrency})`}
                </td>
                <td>
                  {schedule.payoutMethod === null ? "Tous" : PAYOUT_METHOD_LABELS[schedule.payoutMethod]} / {schedule.fundingMethod === null ? "Tous" : FUNDING_METHOD_LABELS[schedule.fundingMethod]}
                </td>
                <td>{feeText(schedule)}</td>
                <td className="number amount">{formatMoney(schedule.minFee, schedule.sourceCurrency)}</td>
                <td className="number amount">{schedule.maxFee === null ? "—" : formatMoney(schedule.maxFee, schedule.sourceCurrency)}</td>
                <td className="number">{schedule.priority}</td>
                <td>
                  {formatDateTime(schedule.validFrom)} → {formatDateTime(schedule.validTo)}
                </td>
                <td>
                  <Badge value={schedule.state} labels={RULE_STATE_LABELS} /> <PendingLink id={schedule.pendingRequestId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(admin, "pricing:manage") && (
        <div className="grid">
          <ActionForm
            action={requestFeeScheduleAction}
            title="Nouveau barème"
            description="Montants dans la devise d'envoi. Laisser vide pour « tous ». Un barème remplacé prend fin à la date d'effet du nouveau."
            fourEyes={fourEyes}
            fields={[
              { name: "sourceCurrency", label: "Devise d'envoi", kind: "text", maxLength: 3, placeholder: "EUR" },
              { name: "sourceCountry", label: "Pays d'envoi", kind: "text", required: false, maxLength: 2, placeholder: "FR" },
              { name: "destinationCountry", label: "Pays de destination", kind: "text", required: false, maxLength: 2, placeholder: "SN" },
              { name: "destinationCurrency", label: "Devise reçue", kind: "text", required: false, maxLength: 3, placeholder: "XOF" },
              { name: "payoutMethod", label: "Mode de réception", kind: "select", required: false, options: [any, ...PAYOUT_METHODS.map((value) => ({ value, label: PAYOUT_METHOD_LABELS[value] }))] },
              { name: "fundingMethod", label: "Moyen de paiement", kind: "select", required: false, options: [any, ...FUNDING_METHODS.map((value) => ({ value, label: FUNDING_METHOD_LABELS[value] }))] },
              { name: "fixedFee", label: "Frais fixes", kind: "text", maxLength: 20, defaultValue: "0" },
              { name: "percentage", label: "Frais proportionnels (%)", kind: "text", maxLength: 5, defaultValue: "0", help: "Entre 0 et 10 %." },
              { name: "minFee", label: "Minimum", kind: "text", maxLength: 20, defaultValue: "0" },
              { name: "maxFee", label: "Plafond", kind: "text", required: false, maxLength: 20, help: "Vide : sans plafond." },
              { name: "priority", label: "Priorité", kind: "text", maxLength: 6, defaultValue: "0" },
              { name: "validFrom", label: "Date d'effet (heure de Paris)", kind: "datetime", required: false, help: "Vide : dès l'approbation. Au plus 90 jours." },
              { name: "validTo", label: "Fin (heure de Paris)", kind: "datetime", required: false },
              {
                name: "replacesScheduleId",
                label: "Remplace le barème (même périmètre)",
                kind: "select",
                required: false,
                options: [{ value: "", label: "Aucun" }, ...open.map((schedule) => ({ value: schedule.id, label: scheduleLabel(schedule) }))],
              },
              { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
            ]}
            submitLabel="Demander le nouveau barème"
          />
          {open.length > 0 && (
            <ActionForm
              action={requestFeeClosureAction}
              title="Clore un barème"
              description="Une clôture avance la fin de validité ; elle ne la repousse jamais."
              fourEyes={fourEyes}
              tone="danger"
              fields={[
                { name: "id", label: "Barème", kind: "select", options: open.map((schedule) => ({ value: schedule.id, label: scheduleLabel(schedule) })) },
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
