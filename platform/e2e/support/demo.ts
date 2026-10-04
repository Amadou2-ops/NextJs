import { existsSync, readFileSync } from "node:fs";

import pg from "pg";

import { openWalletAsMobileApp } from "./customer.js";
import { approveKycAsProvider, withOwner } from "./helpers.js";
import { creditWallet } from "./mobileControl.js";

/**
 * Démonstration locale (`pnpm demo`) : la pile réelle reste démarrée pour un
 * essai dans le navigateur. Ce qu'un service externe fournirait en production
 * est simulé ici, et annoncé dans la console :
 *
 *   - SMS : affichés dans la console (l'API de développement les journalise) ;
 *   - décision du prestataire KYC : identité approuvée dès l'inscription ;
 *   - portefeuilles EUR et USD ouverts (réservé à l'application mobile en
 *     production) et approvisionnés de 1 000,00 chacun par l'exploitant.
 *
 * Aucun prestataire de paiement n'est configuré : un transfert est financé
 * par le portefeuille puis remboursé faute de route de paiement sortant,
 * comme le ferait la production.
 */

const DEMO_BALANCE_MINOR = "100000";

/** Corridors de démonstration au départ des États-Unis (USD) et taux indicatifs. */
export async function configureDemoCorridors(ownerDatabaseUrl: string): Promise<void> {
  const owner = new pg.Client({ connectionString: ownerDatabaseUrl });
  await owner.connect();
  try {
    await owner.query("UPDATE ref.countries SET can_send = true WHERE alpha2 = 'US'");
    await owner.query("UPDATE ref.countries SET can_receive = true WHERE alpha2 IN ('NE', 'MR')");
    await owner.query("UPDATE ref.currencies SET is_enabled = true WHERE code = 'MRU'");
    await owner.query(
      `INSERT INTO payments.payout_corridors (destination_country, destination_currency, payout_method, provider, min_amount, max_amount,
                                              cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled)
       VALUES ('NE', 'XOF', 'mobile_money', 'flutterwave', 500, 2000000, 0, 50, 10, true),
              ('MR', 'MRU', 'mobile_money', 'flutterwave', 1000, 5000000, 0, 50, 10, true)`,
    );
    await owner.query(
      "INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps, priority) VALUES ('USD', 'XOF', 150, 10), ('USD', 'MRU', 150, 10)",
    );
    await owner.query("INSERT INTO transfers.fee_schedules (source_currency, fixed_fee, percentage_bps, min_fee, priority) VALUES ('USD', 299, 0, 0, 0)");
    await owner.query(
      `INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
       VALUES ('open_exchange_rates', 'USD', 'MRU', 39.85, now() - interval '5 minutes')`,
    );
  } finally {
    await owner.end();
  }
}

function newLines(file: string, offsets: Map<string, number>): string[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  const start = offsets.get(file) ?? 0;
  offsets.set(file, content.length);
  return content.slice(start).split("\n").filter((line) => line.length > 0);
}

/** Affiche les SMS et prépare chaque nouveau client ; s'arrête avec le signal fourni. */
export function watchDemo(logFiles: readonly string[], signal: AbortSignal): void {
  const offsets = new Map<string, number>();
  const prepared = new Set<string>();
  let busy = false;
  const tick = async (): Promise<void> => {
    for (const file of logFiles) {
      for (const line of newLines(file, offsets)) {
        if (!line.includes("devSmsBody")) continue;
        try {
          const entry = JSON.parse(line) as { to?: unknown; devSmsBody?: unknown };
          if (typeof entry.devSmsBody === "string") process.stdout.write(`\n📱 SMS pour ${String(entry.to)} : ${entry.devSmsBody}\n`);
        } catch {
          // Ligne de journal non JSON.
        }
      }
    }
    const fresh = await withOwner(async (client) => {
      const result = await client.query<{ id: string }>("SELECT id FROM identity.users WHERE status = 'active' AND kyc_tier = 'tier_0' ORDER BY created_at");
      return result.rows.map((row) => row.id).filter((id) => !prepared.has(id));
    });
    for (const userId of fresh) {
      prepared.add(userId);
      await approveKycAsProvider(userId, { firstName: "Client", lastName: "Démo", dateOfBirth: "1990-01-01" });
      for (const currency of ["USD", "EUR"]) {
        await openWalletAsMobileApp(userId, currency);
        await creditWallet(userId, currency, DEMO_BALANCE_MINOR);
      }
      process.stdout.write(
        "\n✔ Nouveau client préparé (simulation de démonstration) : identité vérifiée, portefeuilles USD et EUR ouverts et crédités de 1 000,00. Rechargez la page.\n",
      );
    }
  };
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((error: unknown) => {
        process.stderr.write(`démo : ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        busy = false;
      });
  }, 1_500);
  signal.addEventListener("abort", () => {
    clearInterval(timer);
  });
}
