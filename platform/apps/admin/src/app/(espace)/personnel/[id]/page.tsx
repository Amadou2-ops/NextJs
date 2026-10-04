import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, NoAccess } from "@/components/ui";
import { formatDateTime, ROLE_LABELS, STAFF_STATUS_LABELS } from "@/lib/format";
import type { StaffMember } from "@/lib/types";
import { STAFF_ROLES } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { renewInvitationAction, requestNetworkAction, requestReactivationAction, requestRolesAction, restrictStaffAction, revokeRoleAction } from "../actions";

export const metadata: Metadata = { title: "Membre du personnel" };

export default async function StaffMemberPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "admins:manage")) return <NoAccess permission="admins:manage" />;
  const member = await sessionApi<StaffMember>(`/personnel/${id}`, { path: `/v1/admin/staff/${id}` });
  const self = member.id === admin.id;
  const fourEyes = requiresFourEyes(admin, "admins:manage");
  const missingRoles = STAFF_ROLES.filter((role) => !member.roles.includes(role));

  return (
    <>
      <h1>
        {member.fullName} <Badge value={member.status} labels={STAFF_STATUS_LABELS} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["E-mail", member.email],
            ["Rôles", member.roles.map((role) => ROLE_LABELS[role]).join(", ") || "—"],
            ["Clés de sécurité actives", member.securityKeys],
            ["Plages d'adresses autorisées", member.allowedIpRanges.join(", ")],
            ["Dernière connexion", formatDateTime(member.lastLoginAt)],
            ["Créé le", formatDateTime(member.createdAt)],
          ]}
        />
      </div>
      {self && <p className="alert info">C&apos;est votre propre compte : vous ne pouvez ni le restreindre ni approuver vos propres demandes.</p>}

      {member.status !== "disabled" && (
        <div className="grid">
          {member.status === "invited" && (
            <ActionForm
              action={renewInvitationAction.bind(null, member.id)}
              title="Renouveler l'invitation"
              description="Révoque le lien précédent et en émet un nouveau, affiché une seule fois."
              fields={[]}
              submitLabel="Émettre un nouveau lien"
            />
          )}
          {missingRoles.length > 0 && member.status !== "suspended" && (
            <ActionForm
              action={requestRolesAction.bind(null, member.id)}
              title="Accorder des rôles"
              fields={[
                { name: "roles", label: "Rôles à accorder", kind: "checkboxes", options: missingRoles.map((role) => ({ value: role, label: ROLE_LABELS[role] })) },
                { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
              ]}
              fourEyes={fourEyes}
              submitLabel="Créer la demande"
            />
          )}
          {member.roles.length > 0 && (
            <ActionForm
              action={revokeRoleAction.bind(null, member.id)}
              title="Retirer un rôle"
              description="Effet immédiat sur toutes les sessions du membre."
              fields={[
                { name: "role", label: "Rôle", kind: "select", options: member.roles.map((role) => ({ value: role, label: ROLE_LABELS[role] })) },
                { name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 },
              ]}
              submitLabel="Retirer"
              tone="danger"
            />
          )}
          <ActionForm
            action={requestNetworkAction.bind(null, member.id)}
            title="Modifier les plages d'adresses autorisées"
            fields={[
              { name: "allowedIpRanges", label: "Nouvelles plages (une par ligne, remplacent les actuelles)", kind: "textarea", maxLength: 1000, placeholder: member.allowedIpRanges.join("\n") },
              { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
            ]}
            fourEyes={fourEyes}
            submitLabel="Créer la demande"
          />
          {member.status === "suspended" && (
            <ActionForm
              action={requestReactivationAction.bind(null, member.id)}
              title="Réactiver le compte"
              fields={[{ name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 }]}
              fourEyes={fourEyes}
              submitLabel="Créer la demande"
            />
          )}
          {!self && (
            <ActionForm
              action={restrictStaffAction.bind(null, member.id)}
              title="Suspendre ou désactiver"
              description="La suspension révoque les sessions ; la désactivation est définitive (clés et invitations révoquées)."
              fields={[
                {
                  name: "status",
                  label: "Mesure",
                  kind: "select",
                  options: [
                    ...(member.status === "suspended" ? [] : [{ value: "suspended", label: "Suspendre" }]),
                    { value: "disabled", label: "Désactiver définitivement" },
                  ],
                },
                { name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 },
              ]}
              confirmation="Je confirme cette mesure, qui prend effet immédiatement."
              submitLabel="Appliquer"
              tone="danger"
            />
          )}
        </div>
      )}
    </>
  );
}
