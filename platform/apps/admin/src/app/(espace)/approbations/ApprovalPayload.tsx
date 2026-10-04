import Link from "next/link";
import type { ReactNode } from "react";

import { Details, Json, Mono } from "@/components/ui";
import { formatBps, FUNDING_METHOD_LABELS, PAYOUT_METHOD_LABELS, PROVIDER_LABELS, RISK_LEVEL_LABELS } from "@/lib/configuration";
import { formatDateTime, formatMoney, ROLE_LABELS } from "@/lib/format";
import type { Approval } from "@/lib/types";
import { STAFF_ROLES } from "@/lib/types";
import { z } from "@/lib/zod";

/**
 * Contenu d'une demande, présenté selon l'action. Le contenu est relu par un
 * schéma : une forme inattendue est montrée brute, jamais interprétée.
 */

const roles = z.array(z.enum(STAFF_ROLES));
const code = z.string().nullable();
const minor = z.string().regex(/^\d+$/);
const corridorParameters = {
  priority: z.number(),
  minAmount: minor,
  maxAmount: minor,
  costFixed: minor,
  costBps: z.number(),
  isEnabled: z.boolean(),
};
const schemas = {
  invite_admin: z.object({ email: z.string(), fullName: z.string(), roles, allowedIpRanges: z.array(z.string()) }),
  grant_roles: z.object({ roles }),
  update_admin_network: z.object({ allowedIpRanges: z.array(z.string()) }),
  refund_transfer: z.object({ reason: z.string() }),
  set_account_status: z.object({ status: z.string(), reason: z.string() }),
  reverse_journal: z.object({ reason: z.string() }),
  file_sar: z.object({ sarReference: z.string() }),
  create_pricing_rule: z.object({
    sourceCurrency: code,
    destinationCurrency: code,
    marginBps: z.number(),
    priority: z.number(),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    replacesRuleId: z.string().nullable(),
  }),
  close_rule: z.object({ validTo: z.string().nullable() }),
  create_fee_schedule: z.object({
    sourceCountry: code,
    destinationCountry: code,
    sourceCurrency: z.string(),
    destinationCurrency: code,
    payoutMethod: code,
    fundingMethod: code,
    fixedFee: minor,
    percentageBps: z.number(),
    minFee: minor,
    maxFee: minor.nullable(),
    priority: z.number(),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    replacesScheduleId: z.string().nullable(),
  }),
  create_payout_corridor: z.object({
    sourceCountry: code,
    destinationCountry: z.string(),
    destinationCurrency: z.string(),
    payoutMethod: z.string(),
    provider: z.string(),
    ...corridorParameters,
    estimatedDeliveryMinutes: z.number(),
    providerRouteCode: code,
  }),
  update_payout_corridor: z.object({ ...corridorParameters, estimatedDeliveryMinutes: z.number(), providerRouteCode: code }),
  create_payin_method: z.object({ country: z.string(), currency: z.string(), fundingMethod: z.string(), provider: z.string(), ...corridorParameters }),
  update_payin_method: z.object(corridorParameters),
  set_payment_provider: z.object({ isEnabled: z.boolean() }),
  update_country: z.object({ canSend: z.boolean(), canReceive: z.boolean(), riskLevel: z.string() }),
  ledger_adjustment: z.object({
    description: z.string(),
    entries: z.array(z.object({ accountId: z.string(), direction: z.enum(["debit", "credit"]), amountMinor: z.string().regex(/^\d+$/), currency: z.string().regex(/^[A-Z]{3}$/) })),
  }),
};

function all(value: string | null): string {
  return value ?? "Tous";
}

function effect(value: string | null): string {
  return value === null ? "Dès l'approbation" : formatDateTime(value);
}

function labelOf(labels: Readonly<Record<string, string | undefined>>, value: string | null): string {
  return value === null ? "Tous" : (labels[value] ?? value);
}

function onOff(value: boolean): string {
  return value ? "Ouvert" : "Fermé";
}

function roleList(values: readonly (typeof STAFF_ROLES)[number][]): string {
  return values.map((role) => ROLE_LABELS[role]).join(", ");
}

export function ApprovalPayload({ approval }: { readonly approval: Approval }): ReactNode {
  const { actionType, payload, targetId } = approval;
  switch (actionType) {
    case "invite_admin": {
      const parsed = schemas.invite_admin.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Personne invitée", `${parsed.data.fullName} <${parsed.data.email}>`], ["Rôles", roleList(parsed.data.roles)], ["Réseaux autorisés", parsed.data.allowedIpRanges.join(", ")]]} />;
    }
    case "grant_roles": {
      const parsed = schemas.grant_roles.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Membre", <Link key="m" href={`/personnel/${targetId}`}>{targetId}</Link>], ["Rôles accordés", roleList(parsed.data.roles)]]} />;
    }
    case "reactivate_admin":
      return <Details items={[["Membre à réactiver", <Link key="m" href={`/personnel/${targetId}`}>{targetId}</Link>]]} />;
    case "update_admin_network": {
      const parsed = schemas.update_admin_network.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Membre", <Link key="m" href={`/personnel/${targetId}`}>{targetId}</Link>], ["Nouvelles plages autorisées", parsed.data.allowedIpRanges.join(", ")]]} />;
    }
    case "refund_transfer": {
      const parsed = schemas.refund_transfer.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Transfert", <Link key="t" href={`/transferts/${targetId}`}>{targetId}</Link>], ["Motif communiqué", parsed.data.reason]]} />;
    }
    case "set_account_status": {
      const parsed = schemas.set_account_status.safeParse(payload);
      if (!parsed.success) break;
      return (
        <Details
          items={[
            ["Compte du registre", <Link key="a" href={`/registre/comptes/${targetId}`}>{targetId}</Link>],
            ["Nouvel état", parsed.data.status === "frozen" ? "Gelé" : "Actif"],
            ["Motif", parsed.data.reason],
          ]}
        />
      );
    }
    case "reverse_journal": {
      const parsed = schemas.reverse_journal.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Journal à contre-passer", <Link key="j" href={`/registre/journaux/${targetId}`}>{targetId}</Link>], ["Motif", parsed.data.reason]]} />;
    }
    case "file_sar": {
      const parsed = schemas.file_sar.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Dossier", <Link key="c" href={`/aml/dossiers/${targetId}`}>{targetId}</Link>], ["Référence de la déclaration", <Mono key="r">{parsed.data.sarReference}</Mono>]]} />;
    }
    case "ledger_adjustment": {
      const parsed = schemas.ledger_adjustment.safeParse(payload);
      if (!parsed.success) break;
      return (
        <>
          <Details items={[["Libellé", parsed.data.description]]} />
          <table>
            <thead>
              <tr>
                <th>Compte</th>
                <th>Sens</th>
                <th className="number">Montant</th>
              </tr>
            </thead>
            <tbody>
              {parsed.data.entries.map((entry, index) => (
                <tr key={`${entry.accountId}-${index.toString()}`}>
                  <td>
                    <Link href={`/registre/comptes/${entry.accountId}`}>{entry.accountId}</Link>
                  </td>
                  <td>{entry.direction === "debit" ? "Débit" : "Crédit"}</td>
                  <td className="number amount">{formatMoney(entry.amountMinor, entry.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
    }
    case "create_pricing_rule": {
      const parsed = schemas.create_pricing_rule.safeParse(payload);
      if (!parsed.success) break;
      const rule = parsed.data;
      return (
        <Details
          items={[
            ["Devises", `${all(rule.sourceCurrency)} → ${all(rule.destinationCurrency)}`],
            ["Marge", formatBps(rule.marginBps)],
            ["Priorité", rule.priority],
            ["Date d'effet", effect(rule.validFrom)],
            ["Fin", rule.validTo === null ? "—" : formatDateTime(rule.validTo)],
            ["Remplace la marge", rule.replacesRuleId === null ? "—" : <Mono key="r">{rule.replacesRuleId}</Mono>],
            ["Identifiant créé", <Mono key="t">{targetId}</Mono>],
          ]}
        />
      );
    }
    case "close_pricing_rule":
    case "close_fee_schedule": {
      const parsed = schemas.close_rule.safeParse(payload);
      if (!parsed.success) break;
      const page = actionType === "close_pricing_rule" ? "/parametrage/marges?etat=tout" : "/parametrage/frais?etat=tout";
      return (
        <Details
          items={[
            [actionType === "close_pricing_rule" ? "Marge" : "Barème", <Link key="r" href={page}>{targetId}</Link>],
            ["Fin de validité", effect(parsed.data.validTo)],
          ]}
        />
      );
    }
    case "create_fee_schedule": {
      const parsed = schemas.create_fee_schedule.safeParse(payload);
      if (!parsed.success) break;
      const fee = parsed.data;
      return (
        <Details
          items={[
            ["Devise d'envoi", fee.sourceCurrency],
            ["Origine → destination", `${all(fee.sourceCountry)} → ${all(fee.destinationCountry)}${fee.destinationCurrency === null ? "" : ` (${fee.destinationCurrency})`}`],
            ["Réception", labelOf(PAYOUT_METHOD_LABELS, fee.payoutMethod)],
            ["Moyen de paiement", labelOf(FUNDING_METHOD_LABELS, fee.fundingMethod)],
            ["Frais", `${formatMoney(fee.fixedFee, fee.sourceCurrency)} + ${formatBps(fee.percentageBps)}`],
            ["Minimum / plafond", `${formatMoney(fee.minFee, fee.sourceCurrency)} / ${fee.maxFee === null ? "sans plafond" : formatMoney(fee.maxFee, fee.sourceCurrency)}`],
            ["Priorité", fee.priority],
            ["Date d'effet", effect(fee.validFrom)],
            ["Fin", fee.validTo === null ? "—" : formatDateTime(fee.validTo)],
            ["Remplace le barème", fee.replacesScheduleId === null ? "—" : <Mono key="r">{fee.replacesScheduleId}</Mono>],
          ]}
        />
      );
    }
    case "create_payout_corridor": {
      const parsed = schemas.create_payout_corridor.safeParse(payload);
      if (!parsed.success) break;
      const corridor = parsed.data;
      return (
        <Details
          items={[
            ["Corridor", `${all(corridor.sourceCountry)} → ${corridor.destinationCountry} (${corridor.destinationCurrency})`],
            ["Réception", labelOf(PAYOUT_METHOD_LABELS, corridor.payoutMethod)],
            ["Prestataire", labelOf(PROVIDER_LABELS, corridor.provider)],
            ["Code du payeur", corridor.providerRouteCode ?? "—"],
            ["Montants", `${formatMoney(corridor.minAmount, corridor.destinationCurrency)} – ${formatMoney(corridor.maxAmount, corridor.destinationCurrency)}`],
            ["Coût prestataire", `${formatMoney(corridor.costFixed, corridor.destinationCurrency)} + ${formatBps(corridor.costBps)}`],
            ["Délai", `${corridor.estimatedDeliveryMinutes.toString()} min`],
            ["Priorité", corridor.priority],
            ["État demandé", onOff(corridor.isEnabled)],
          ]}
        />
      );
    }
    case "update_payout_corridor": {
      const parsed = schemas.update_payout_corridor.safeParse(payload);
      if (!parsed.success) break;
      const corridor = parsed.data;
      return (
        <Details
          items={[
            ["Corridor", <Link key="c" href={`/parametrage/corridors/${targetId}`}>{targetId}</Link>],
            ["Montants (unités mineures)", `${corridor.minAmount} – ${corridor.maxAmount}`],
            ["Coût prestataire", `${corridor.costFixed} (unités mineures) + ${formatBps(corridor.costBps)}`],
            ["Délai", `${corridor.estimatedDeliveryMinutes.toString()} min`],
            ["Code du payeur", corridor.providerRouteCode ?? "—"],
            ["Priorité", corridor.priority],
            ["État demandé", onOff(corridor.isEnabled)],
          ]}
        />
      );
    }
    case "create_payin_method": {
      const parsed = schemas.create_payin_method.safeParse(payload);
      if (!parsed.success) break;
      const method = parsed.data;
      return (
        <Details
          items={[
            ["Pays / devise", `${method.country} (${method.currency})`],
            ["Moyen", labelOf(FUNDING_METHOD_LABELS, method.fundingMethod)],
            ["Prestataire", labelOf(PROVIDER_LABELS, method.provider)],
            ["Montants", `${formatMoney(method.minAmount, method.currency)} – ${formatMoney(method.maxAmount, method.currency)}`],
            ["Coût prestataire", `${formatMoney(method.costFixed, method.currency)} + ${formatBps(method.costBps)}`],
            ["Priorité", method.priority],
            ["État demandé", onOff(method.isEnabled)],
          ]}
        />
      );
    }
    case "update_payin_method": {
      const parsed = schemas.update_payin_method.safeParse(payload);
      if (!parsed.success) break;
      const method = parsed.data;
      return (
        <Details
          items={[
            ["Moyen d'encaissement", <Link key="m" href={`/parametrage/encaissement/${targetId}`}>{targetId}</Link>],
            ["Montants (unités mineures)", `${method.minAmount} – ${method.maxAmount}`],
            ["Coût prestataire", `${method.costFixed} (unités mineures) + ${formatBps(method.costBps)}`],
            ["Priorité", method.priority],
            ["État demandé", onOff(method.isEnabled)],
          ]}
        />
      );
    }
    case "set_payment_provider": {
      const parsed = schemas.set_payment_provider.safeParse(payload);
      if (!parsed.success) break;
      return <Details items={[["Prestataire", labelOf(PROVIDER_LABELS, targetId)], ["Action", parsed.data.isEnabled ? "Activation" : "Coupure"]]} />;
    }
    case "update_country": {
      const parsed = schemas.update_country.safeParse(payload);
      if (!parsed.success) break;
      return (
        <Details
          items={[
            ["Pays", <Link key="p" href={`/parametrage/pays/${targetId}`}>{targetId}</Link>],
            ["Envoi", onOff(parsed.data.canSend)],
            ["Réception", onOff(parsed.data.canReceive)],
            ["Niveau de risque", labelOf(RISK_LEVEL_LABELS, parsed.data.riskLevel)],
          ]}
        />
      );
    }
    default:
      break;
  }
  return <Json value={payload} />;
}
