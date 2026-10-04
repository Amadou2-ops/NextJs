import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, Json, NoAccess } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { KycDetail } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { decideKycAction, revealKycIdentityAction } from "../actions";
import { KYC_REASONS } from "../reasons";
import { IdentityReveal } from "../IdentityReveal";

export const metadata: Metadata = { title: "Vérification d'identité" };

export default async function KycDetailPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "kyc:read")) return <NoAccess permission="kyc:read" />;
  const verification = await sessionApi<KycDetail>(`/kyc/${id}`, { path: `/v1/admin/kyc/verifications/${id}` });
  const evidence = verification.evidence;
  const decidable = verification.status === "in_review" || verification.status === "submitted";

  return (
    <>
      <h1>
        Vérification d&apos;identité <Badge value={verification.status} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Client", can(admin, "customers:read") ? <Link key="c" href={`/clients/${verification.userId}`}>{verification.customerNumber}</Link> : verification.customerNumber],
            ["Prestataire", `${verification.provider} (${verification.jobType})`],
            ["Niveau demandé", verification.tier],
            ["Score de détection du vivant", verification.livenessScore],
            ["Score de correspondance de la pièce", verification.documentMatchScore],
            ["Soumise le", formatDateTime(verification.submittedAt)],
            ["Motifs", verification.reasons.length === 0 ? "—" : verification.reasons.join(", ")],
          ]}
        />
      </div>

      <h2>Pièce d&apos;identité</h2>
      {evidence === null ? (
        <p className="muted">Aucune donnée extraite par le prestataire.</p>
      ) : (
        <div className="card stack">
          <Details
            items={[
              ["Type de pièce", evidence.documentType],
              ["Pays émetteur", evidence.issuingCountry],
              ["Identité conforme à la déclaration", evidence.declaredIdentityMatch === null ? "Non évaluée" : evidence.declaredIdentityMatch ? "Oui" : "Non"],
              [
                "Pièce utilisée par d'autres clients",
                evidence.documentSharedWithOtherCustomers === 0 ? "Non" : <strong key="d" className="negative">Oui ({evidence.documentSharedWithOtherCustomers})</strong>,
              ],
            ]}
          />
          {can(admin, "customers:read_pii") && <IdentityReveal action={revealKycIdentityAction.bind(null, verification.id)} />}
        </div>
      )}

      {verification.review !== null && (
        <>
          <h2>Revue</h2>
          <Json value={verification.review} />
        </>
      )}

      <h2>Historique</h2>
      <ol className="timeline">
        {verification.history.map((event, index) => (
          <li key={`${event.at}-${index.toString()}`}>
            <strong>{event.to}</strong> — {formatDateTime(event.at)}
            <br />
            <span className="small muted">
              {event.actor.type}
              {event.actor.id === null ? "" : ` ${event.actor.id}`}
              {event.note === null ? "" : ` · ${event.note}`}
            </span>
          </li>
        ))}
      </ol>

      {can(admin, "kyc:decide") && decidable && (
        <ActionForm
          action={decideKycAction.bind(null, verification.id)}
          title="Décision"
          description="Un refus ou une demande de nouvelle pièce doit être motivé."
          fields={[
            {
              name: "decision",
              label: "Décision",
              kind: "select",
              options: [
                { value: "approve", label: "Approuver" },
                { value: "resubmission_required", label: "Demander une nouvelle pièce" },
                { value: "reject", label: "Refuser" },
              ],
            },
            { name: "reasons", label: "Motifs", kind: "checkboxes", options: KYC_REASONS.map(([value, text]) => ({ value, label: text })) },
            { name: "note", label: "Note de revue", kind: "textarea", minLength: 10, maxLength: 2000 },
          ]}
          submitLabel="Enregistrer la décision"
        />
      )}
    </>
  );
}
