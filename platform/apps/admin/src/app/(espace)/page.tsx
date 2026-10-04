import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge, Details } from "@/components/ui";
import { formatDateTime, PERMISSION_LABELS, ROLE_LABELS } from "@/lib/format";
import type { AmlAlert, Approval, KycVerification, Page, TransferSummary } from "@/lib/types";
import { can, currentAdmin } from "@/server/admin";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Accueil" };

/** Tableau de bord : files de travail accessibles au membre et ses habilitations. */
export default async function HomePage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  const [approvals, kyc, alerts, review] = await Promise.all([
    can(admin, "approvals:decide") ? sessionApi<{ items: Approval[] }>("/", { path: "/v1/admin/approvals", query: { status: "pending", limit: "200" } }) : null,
    can(admin, "kyc:read") ? sessionApi<{ items: KycVerification[] }>("/", { path: "/v1/admin/kyc/reviews", query: { limit: "200" } }) : null,
    can(admin, "aml:alerts:read") ? sessionApi<{ items: AmlAlert[] }>("/", { path: "/v1/admin/aml/alerts", query: { limit: "200" } }) : null,
    can(admin, "transfers:read") ? sessionApi<Page<TransferSummary>>("/", { path: "/v1/admin/transfers", query: { status: "compliance_review", limit: "200" } }) : null,
  ]);
  const awaitingOthers = approvals?.items.filter((item) => item.requestedBy.id !== admin.id).length ?? 0;
  const urgentAlerts = alerts?.items.filter((alert) => alert.severity === "critical" || alert.severity === "high").length ?? 0;

  return (
    <>
      <h1>Bonjour {admin.fullName}</h1>
      <div className="grid">
        {approvals !== null && (
          <Link className="card tile" href="/approbations">
            <span className="tile-value">{awaitingOthers}</span>
            <span>demande(s) à valider</span>
          </Link>
        )}
        {review !== null && (
          <Link className="card tile" href="/transferts?status=compliance_review">
            <span className="tile-value">{review.items.length}</span>
            <span>transfert(s) en revue de conformité</span>
          </Link>
        )}
        {kyc !== null && (
          <Link className="card tile" href="/kyc">
            <span className="tile-value">{kyc.items.length}</span>
            <span>vérification(s) d&apos;identité à revoir</span>
          </Link>
        )}
        {alerts !== null && (
          <Link className="card tile" href="/aml/alertes">
            <span className="tile-value">{alerts.items.length}</span>
            <span>alerte(s) ouvertes, dont {urgentAlerts} élevée(s) ou critique(s)</span>
          </Link>
        )}
      </div>

      <h2>Mon compte</h2>
      <div className="card">
        <Details
          items={[
            ["Adresse e-mail", admin.email],
            ["Rôles", admin.roles.map((role) => ROLE_LABELS[role]).join(", ")],
            ["Clés de sécurité actives", admin.securityKeys],
            ["Réseaux autorisés", admin.allowedIpRanges.join(", ")],
            ["Dernière connexion", formatDateTime(admin.lastLoginAt)],
          ]}
        />
      </div>
      <h2>Mes habilitations</h2>
      <div className="card">
        <ul className="permissions">
          {admin.permissions.map((permission) => (
            <li key={permission}>
              {PERMISSION_LABELS[permission]} <code>{permission}</code>
              {admin.fourEyesPermissions.includes(permission) && <Badge value="four-eyes" tone="four-eyes" labels={{ "four-eyes": "double validation" }} />}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
