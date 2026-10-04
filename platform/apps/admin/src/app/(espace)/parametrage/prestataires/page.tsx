import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Badge, Details } from "@/components/ui";
import type { PaymentProvider } from "@/lib/configuration";
import { CIRCUIT_LABELS, PROVIDER_LABELS } from "@/lib/configuration";
import { formatDateTime } from "@/lib/format";
import { can, currentAdmin, requiresFourEyes } from "@/server/admin";
import { sessionApi } from "@/server/context";

import { requestProviderAction } from "../actions";
import { JUSTIFICATION } from "../fields";
import { PendingLink } from "../PendingLink";

export const metadata: Metadata = { title: "Prestataires de paiement" };

export default async function ProvidersPage(): Promise<ReactNode> {
  const admin = await currentAdmin();
  const { items } = await sessionApi<{ items: PaymentProvider[] }>("/parametrage/prestataires", { path: "/v1/admin/configuration/providers" });
  const manage = can(admin, "routing:manage");

  return (
    <>
      <h1>Prestataires de paiement</h1>
      <p className="muted">
        Couper un prestataire retire immédiatement ses corridors et moyens d&apos;encaissement des routes proposées ; les paiements en cours se terminent chez
        lui. Le passage du bac à sable à la production ne se fait que par migration, après le contrôle des comptes (PRESTATAIRES.md).
      </p>
      <div className="grid">
        {items.map((provider) => (
          <section key={provider.code} className="card stack">
            <h2>
              {PROVIDER_LABELS[provider.code]} <Badge value={provider.isEnabled ? "active" : "disabled"} labels={{ active: "Activé", disabled: "Désactivé" }} />{" "}
              <PendingLink id={provider.pendingRequestId} />
            </h2>
            <Details
              items={[
                ["Environnement", provider.environment === "live" ? "Production" : "Bac à sable"],
                ["Encaissement / versement", `${provider.supportsPayin ? "oui" : "non"} / ${provider.supportsPayout ? "oui" : "non"}`],
                ["Disjoncteur", <Badge key="c" value={provider.circuitState} labels={CIRCUIT_LABELS} />],
                ["Dernière modification", formatDateTime(provider.updatedAt)],
              ]}
            />
            {manage && provider.pendingRequestId === null && (
              <ActionForm
                action={requestProviderAction.bind(null, provider.code, !provider.isEnabled)}
                title={provider.isEnabled ? `Couper ${PROVIDER_LABELS[provider.code]}` : `Activer ${PROVIDER_LABELS[provider.code]}`}
                fourEyes={requiresFourEyes(admin, "routing:manage")}
                tone={provider.isEnabled ? "danger" : "primary"}
                fields={[JUSTIFICATION]}
                submitLabel={provider.isEnabled ? "Demander la coupure" : "Demander l'activation"}
              />
            )}
          </section>
        ))}
      </div>
    </>
  );
}
