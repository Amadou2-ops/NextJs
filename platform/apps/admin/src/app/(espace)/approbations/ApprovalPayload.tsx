import Link from "next/link";
import type { ReactNode } from "react";

import { Details, Json, Mono } from "@/components/ui";
import { formatMoney, ROLE_LABELS } from "@/lib/format";
import type { Approval } from "@/lib/types";
import { STAFF_ROLES } from "@/lib/types";
import { z } from "@/lib/zod";

/**
 * Contenu d'une demande, présenté selon l'action. Le contenu est relu par un
 * schéma : une forme inattendue est montrée brute, jamais interprétée.
 */

const roles = z.array(z.enum(STAFF_ROLES));
const schemas = {
  invite_admin: z.object({ email: z.string(), fullName: z.string(), roles, allowedIpRanges: z.array(z.string()) }),
  grant_roles: z.object({ roles }),
  update_admin_network: z.object({ allowedIpRanges: z.array(z.string()) }),
  refund_transfer: z.object({ reason: z.string() }),
  set_account_status: z.object({ status: z.string(), reason: z.string() }),
  reverse_journal: z.object({ reason: z.string() }),
  file_sar: z.object({ sarReference: z.string() }),
  ledger_adjustment: z.object({
    description: z.string(),
    entries: z.array(z.object({ accountId: z.string(), direction: z.enum(["debit", "credit"]), amountMinor: z.string().regex(/^\d+$/), currency: z.string().regex(/^[A-Z]{3}$/) })),
  }),
};

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
    default:
      break;
  }
  return <Json value={payload} />;
}
