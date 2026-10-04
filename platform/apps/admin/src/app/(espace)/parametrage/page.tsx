import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui";
import type { CountrySetting, FeeSchedule, PaymentProvider, PayoutCorridor, PricingRule } from "@/lib/configuration";
import { CIRCUIT_LABELS, PROVIDER_LABELS } from "@/lib/configuration";
import { sessionApi } from "@/server/context";

export const metadata: Metadata = { title: "Paramétrage" };

export default async function ConfigurationOverviewPage(): Promise<ReactNode> {
  const [rules, schedules, corridors, providers, countries] = await Promise.all([
    sessionApi<{ items: PricingRule[] }>("/parametrage", { path: "/v1/admin/configuration/pricing-rules" }),
    sessionApi<{ items: FeeSchedule[] }>("/parametrage", { path: "/v1/admin/configuration/fee-schedules" }),
    sessionApi<{ items: PayoutCorridor[] }>("/parametrage", { path: "/v1/admin/configuration/payout-corridors" }),
    sessionApi<{ items: PaymentProvider[] }>("/parametrage", { path: "/v1/admin/configuration/providers" }),
    sessionApi<{ items: CountrySetting[] }>("/parametrage", { path: "/v1/admin/configuration/countries" }),
  ]);
  const pending = [...rules.items, ...schedules.items, ...corridors.items, ...providers.items, ...countries.items].filter((item) => item.pendingRequestId !== null).length;
  const live = corridors.items.filter((corridor) => corridor.isEnabled && corridor.providerEnabled);

  return (
    <>
      <h1>Paramétrage</h1>
      <p className="muted">
        Toute modification est une demande approuvée par un second membre habilité ; la base n&apos;écrit que la ligne décrite par la demande, sans effet
        rétroactif. Un devis déjà émis conserve ses conditions.
      </p>
      {pending > 0 && (
        <p className="alert info">
          {pending} demande{pending > 1 ? "s" : ""} de modification en cours : voir les <Link href="/approbations">approbations</Link>.
        </p>
      )}
      <div className="grid">
        <section className="card">
          <h2>
            <Link href="/parametrage/marges">Marges de change</Link>
          </h2>
          <p>{rules.items.filter((rule) => rule.state === "active").length} en vigueur, {rules.items.filter((rule) => rule.state === "scheduled").length} programmée(s)</p>
        </section>
        <section className="card">
          <h2>
            <Link href="/parametrage/frais">Frais</Link>
          </h2>
          <p>{schedules.items.filter((schedule) => schedule.state === "active").length} barème(s) en vigueur, {schedules.items.filter((schedule) => schedule.state === "scheduled").length} programmé(s)</p>
        </section>
        <section className="card">
          <h2>
            <Link href="/parametrage/corridors">Corridors</Link>
          </h2>
          <p>
            {live.length} ouvert(s) sur {corridors.items.length}, vers {new Set(live.map((corridor) => corridor.destinationCountry)).size} pays
          </p>
        </section>
        <section className="card">
          <h2>
            <Link href="/parametrage/pays">Pays</Link>
          </h2>
          <p>
            {countries.items.filter((item) => item.canSend).length} ouvert(s) à l&apos;envoi, {countries.items.filter((item) => item.canReceive).length} à la réception
          </p>
        </section>
      </div>
      <h2>Prestataires</h2>
      <table>
        <thead>
          <tr>
            <th>Prestataire</th>
            <th>Environnement</th>
            <th>État</th>
            <th>Disjoncteur</th>
          </tr>
        </thead>
        <tbody>
          {providers.items.map((provider) => (
            <tr key={provider.code}>
              <td>{PROVIDER_LABELS[provider.code]}</td>
              <td>{provider.environment === "live" ? "Production" : "Bac à sable"}</td>
              <td>
                <Badge value={provider.isEnabled ? "active" : "disabled"} labels={{ active: "Activé", disabled: "Désactivé" }} />
              </td>
              <td>
                <Badge value={provider.circuitState} labels={CIRCUIT_LABELS} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
