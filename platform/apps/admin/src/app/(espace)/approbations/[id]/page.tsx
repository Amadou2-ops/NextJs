import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, NoAccess } from "@/components/ui";
import { ACTION_TYPE_LABELS, APPROVAL_STATUS_LABELS, formatDateTime, label, PERMISSION_LABELS } from "@/lib/format";
import type { Approval, Permission } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";
import { notFound } from "next/navigation";

import { approveAction, rejectAction } from "../actions";
import { ApprovalPayload } from "../ApprovalPayload";

export const metadata: Metadata = { title: "Demande" };

export default async function ApprovalPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "approvals:decide")) return <NoAccess permission="approvals:decide" />;
  const approval = await sessionApi<Approval>(`/approbations/${id}`, { path: `/v1/admin/approvals/${id}` });
  const ownRequest = approval.requestedBy.id === admin.id;
  const permission = approval.permission as Permission;
  const holdsPermission = can(admin, permission);

  return (
    <>
      <h1>{label(ACTION_TYPE_LABELS, approval.actionType)}</h1>
      <div className="card">
        <Details
          items={[
            ["État", <Badge key="s" value={approval.status} labels={APPROVAL_STATUS_LABELS} />],
            ["Permission exigée", `${label(PERMISSION_LABELS, approval.permission)} (${approval.permission})`],
            ["Demandée par", `${approval.requestedBy.name} — ${formatDateTime(approval.requestedAt)}`],
            ["Justification", approval.justification],
            ["Expire", formatDateTime(approval.expiresAt)],
            ["Décision", approval.decidedBy === null ? "—" : `${approval.decidedBy.name} — ${formatDateTime(approval.decidedAt)}`],
            ["Note de décision", approval.decisionNote],
            ["Exécutée", formatDateTime(approval.executedAt)],
          ]}
        />
      </div>
      <h2>Contenu de la demande</h2>
      <div className="card">
        <ApprovalPayload approval={approval} />
      </div>

      {approval.status === "pending" &&
        (ownRequest ? (
          <p className="alert info">Vous êtes l&apos;auteur de cette demande : un autre membre habilité doit statuer (règle des quatre yeux).</p>
        ) : !holdsPermission ? (
          <p className="alert info">Statuer exige aussi la permission « {label(PERMISSION_LABELS, approval.permission)} », que vous ne détenez pas.</p>
        ) : (
          <div className="grid">
            <ActionForm
              action={approveAction.bind(null, approval.id)}
              title="Approuver et exécuter"
              description="L'action est exécutée immédiatement, en votre nom, dans la même transaction que l'approbation."
              fields={[{ name: "note", label: "Note (facultative)", kind: "textarea", required: false, maxLength: 2000 }]}
              confirmation="J'ai vérifié le contenu et la justification de cette demande."
              submitLabel="Approuver et exécuter"
            />
            <ActionForm
              action={rejectAction.bind(null, approval.id)}
              title="Refuser"
              fields={[{ name: "note", label: "Motif du refus", kind: "textarea", minLength: 10, maxLength: 2000 }]}
              submitLabel="Refuser la demande"
              tone="danger"
            />
          </div>
        ))}
    </>
  );
}
