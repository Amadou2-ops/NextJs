import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { NoAccess } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/format";
import { STAFF_ROLES } from "@/lib/types";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";

import { inviteStaffAction } from "../actions";

export const metadata: Metadata = { title: "Inviter un membre" };

export default async function InvitePage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  if (!can(admin, "admins:manage")) return <NoAccess permission="admins:manage" />;
  return (
    <>
      <h1>Inviter un membre du personnel</h1>
      <p className="muted">
        Après approbation par un second administrateur, un lien d&apos;enrôlement à usage unique est remis à l&apos;approbateur, qui le transmet par un canal sûr. Le membre choisit alors son mot de passe et enregistre sa clé de sécurité matérielle.
      </p>
      <ActionForm
        action={inviteStaffAction}
        title="Invitation"
        fields={[
          { name: "fullName", label: "Nom complet", kind: "text", minLength: 2, maxLength: 120 },
          { name: "email", label: "Adresse e-mail professionnelle", kind: "text", maxLength: 254 },
          { name: "roles", label: "Rôles", kind: "checkboxes", options: STAFF_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })) },
          {
            name: "allowedIpRanges",
            label: "Plages d'adresses autorisées (une par ligne)",
            kind: "textarea",
            maxLength: 1000,
            placeholder: "203.0.113.0/24",
            help: "Réseau de l'entreprise ou VPN : IPv4 /16 à /32, IPv6 /32 à /128.",
          },
          { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 },
        ]}
        fourEyes={requiresFourEyes(admin, "admins:manage")}
        submitLabel="Créer la demande d'invitation"
      />
    </>
  );
}
