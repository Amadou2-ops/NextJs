import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details, Json, NoAccess } from "@/components/ui";
import { CASE_STATUS_LABELS, formatDateTime, formatMoney, label } from "@/lib/format";
import type { CustomerDetail } from "@/lib/types";
import type { IdParams } from "@/lib/url";
import { UUID_PATTERN, withQuery } from "@/lib/url";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { openCaseAction, revealPiiAction, setCustomerStatusAction } from "../actions";
import { PiiReveal } from "../PiiReveal";

export const metadata: Metadata = { title: "Fiche client" };

export default async function CustomerPage({ params }: { readonly params: IdParams }): Promise<ReactNode> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const admin = await currentAdmin();
  if (!can(admin, "customers:read")) return <NoAccess permission="customers:read" />;
  const customer = await sessionApi<CustomerDetail>(`/clients/${id}`, { path: `/v1/admin/customers/${id}` });
  const risk = customer.riskProfile;

  return (
    <>
      <h1>
        Client n° {customer.customerNumber} <Badge value={customer.status} />
      </h1>
      <div className="card">
        <Details
          items={[
            ["Identifiant", <code key="id">{customer.id}</code>],
            ["Niveau KYC", customer.kycTier],
            ["Pays de résidence", customer.countryOfResidence],
            ["Indicatif du téléphone", customer.phoneCountry],
            ["Inscrit le", formatDateTime(customer.createdAt)],
            ["Dernière connexion", formatDateTime(customer.lastLoginAt)],
            ["Second facteur TOTP", customer.mfaEnabled ? "Activé" : "Non"],
            ["E-mail vérifié", customer.emailVerified ? "Oui" : "Non"],
            ["Suspendu le", formatDateTime(customer.suspendedAt)],
            [
              "Transferts",
              <Link key="t" href={withQuery("/transferts", { userId: customer.id })}>
                {customer.transfers.total} au total, {customer.transfers.inReview} en revue
              </Link>,
            ],
            ["Alertes ouvertes", customer.openAlerts],
          ]}
        />
      </div>

      {can(admin, "customers:read_pii") && <PiiReveal action={revealPiiAction.bind(null, customer.id)} />}

      <h2>Profil de risque</h2>
      {risk === null ? (
        <p className="muted">Aucune évaluation.</p>
      ) : (
        <div className="card">
          <Details
            items={[
              ["Niveau", <Badge key="l" value={risk.level} />],
              ["Score", risk.score],
              ["Personne politiquement exposée", risk.pep ? "Oui" : "Non"],
              ["Sanctionné", risk.sanctioned ? "Oui" : "Non"],
              ["Vigilance renforcée", risk.enhancedDueDiligence ? "Oui" : "Non"],
              ["Évalué le", formatDateTime(risk.assessedAt)],
            ]}
          />
          <Json value={risk.factors} />
        </div>
      )}

      <h2>Portefeuilles</h2>
      {customer.wallets.length === 0 ? (
        <p className="muted">Aucun portefeuille.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Devise</th>
              <th className="number">Disponible</th>
              <th className="number">Réservé</th>
            </tr>
          </thead>
          <tbody>
            {customer.wallets.map((wallet) => (
              <tr key={wallet.currency}>
                <td>{wallet.currency}</td>
                <td className="number amount">{formatMoney(wallet.availableMinor, wallet.currency)}</td>
                <td className="number amount">{formatMoney(wallet.heldMinor, wallet.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Vérifications d&apos;identité</h2>
      {customer.verifications.length === 0 ? (
        <p className="muted">Aucune vérification.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Créée le</th>
              <th>Prestataire</th>
              <th>Niveau</th>
              <th>État</th>
              <th>Décision</th>
              <th>Expire</th>
            </tr>
          </thead>
          <tbody>
            {customer.verifications.map((verification) => (
              <tr key={verification.id}>
                <td>{can(admin, "kyc:read") ? <Link href={`/kyc/${verification.id}`}>{formatDateTime(verification.createdAt)}</Link> : formatDateTime(verification.createdAt)}</td>
                <td>{verification.provider}</td>
                <td>{verification.tier}</td>
                <td>
                  <Badge value={verification.status} />
                </td>
                <td>{verification.manualDecision ? "Manuelle" : "Automatique"}</td>
                <td>{formatDateTime(verification.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Dossiers d&apos;enquête</h2>
      {customer.cases.length === 0 ? (
        <p className="muted">Aucun dossier.</p>
      ) : (
        <ul>
          {customer.cases.map((item) => (
            <li key={item.id}>
              <Link href={`/aml/dossiers/${item.id}`}>Dossier n° {item.caseNumber}</Link> — {label(CASE_STATUS_LABELS, item.status)}
            </li>
          ))}
        </ul>
      )}

      <h2>Actions</h2>
      <div className="grid">
        {can(admin, "customers:suspend") &&
          (customer.status === "suspended" ? (
            <ActionForm
              action={setCustomerStatusAction.bind(null, customer.id, "active")}
              title="Rétablir le client"
              fields={[{ name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 }]}
              submitLabel="Rétablir"
            />
          ) : customer.status === "active" || customer.status === "pending_verification" ? (
            <ActionForm
              action={setCustomerStatusAction.bind(null, customer.id, "suspended")}
              title="Suspendre le client"
              description="Toutes ses sessions sont révoquées immédiatement ; il ne peut plus initier d'opération."
              fields={[{ name: "reason", label: "Motif", kind: "textarea", minLength: 10, maxLength: 1000 }]}
              submitLabel="Suspendre"
              tone="danger"
            />
          ) : null)}
        {can(admin, "aml:cases:manage") && (
          <ActionForm
            action={openCaseAction.bind(null, customer.id)}
            title="Ouvrir un dossier d'enquête"
            fields={[{ name: "summary", label: "Résumé des faits", kind: "textarea", minLength: 10, maxLength: 5000 }]}
            submitLabel="Ouvrir le dossier"
          />
        )}
      </div>
    </>
  );
}
