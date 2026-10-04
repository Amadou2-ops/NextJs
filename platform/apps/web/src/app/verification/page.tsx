import type { Metadata } from "next";
import type { ReactNode } from "react";

import { formatDateTime, formatMoney } from "@/lib/format";
import type { KycOverview, KycVerification } from "@/lib/types";
import { sessionApi } from "@/server/context";

import { KycLauncher } from "./KycLauncher";

export const metadata: Metadata = { title: "Vérification d'identité" };

const STATUS_LABELS: Readonly<Record<KycVerification["status"], string>> = {
  created: "Créée",
  pending_submission: "Capture à terminer",
  submitted: "Documents transmis",
  in_review: "En cours d'examen",
  approved: "Validée",
  rejected: "Refusée",
  resubmission_required: "Nouveaux documents demandés",
  expired: "Expirée",
};

export default async function KycPage(): Promise<ReactNode> {
  const kyc = await sessionApi<KycOverview>("/verification", { path: "/v1/kyc" });
  const waiting = kyc.activeVerification !== null && (kyc.activeVerification.nextAction === "wait" || kyc.activeVerification.status === "in_review");
  return (
    <>
      <h1>Vérification d&apos;identité</h1>
      <div className="grid">
        <section className="card">
          <h2>Mes plafonds</h2>
          <dl>
            <dt className="muted">Par transfert</dt>
            <dd className="amount">{formatMoney(kyc.limits.singleTransferMax)}</dd>
            <dt className="muted">Sur 24 heures</dt>
            <dd className="amount">{formatMoney(kyc.limits.dailyMax)}</dd>
            <dt className="muted">Sur 30 jours</dt>
            <dd className="amount">{formatMoney(kyc.limits.monthlyMax)}</dd>
          </dl>
        </section>
        <section className="card stack">
          <h2>{kyc.nextTier === null ? "Identité vérifiée" : "Relever mes plafonds"}</h2>
          {kyc.nextTier === null && <p>Votre identité est vérifiée au niveau maximal disponible en libre-service.</p>}
          {kyc.nextTier !== null && waiting && <p className="alert info">Votre vérification est en cours d&apos;examen. Nous vous informerons dès qu&apos;elle sera terminée.</p>}
          {kyc.nextTier !== null && !waiting && kyc.attemptsRemaining === 0 && (
            <p className="alert error">Nombre maximal de tentatives atteint. Contactez le service client.</p>
          )}
          {kyc.nextTier !== null && !waiting && kyc.attemptsRemaining > 0 && (
            <>
              <p className="muted">
                Munissez-vous d&apos;une pièce d&apos;identité en cours de validité. Une vidéo courte de votre visage est demandée pour vérifier qu&apos;il s&apos;agit bien
                de vous. Tentatives restantes : {kyc.attemptsRemaining}.
              </p>
              <KycLauncher nextTier={kyc.nextTier} needsIdentity={!kyc.declaredIdentity} />
            </>
          )}
        </section>
      </div>
      {kyc.verifications.length > 0 && (
        <section className="card">
          <h2>Historique</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Niveau</th>
                <th scope="col">Statut</th>
              </tr>
            </thead>
            <tbody>
              {kyc.verifications.map((verification) => (
                <tr key={verification.id}>
                  <td>{formatDateTime(verification.createdAt)}</td>
                  <td>{verification.tier.replace("tier_", "Niveau ")}</td>
                  <td>{STATUS_LABELS[verification.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
