import type { Queryable } from "../../db/transaction.js";
import type { FundingMethod, PaymentProviderName, PayoutMethod } from "./providers/types.js";

/**
 * Moteur de routage.
 *   - Encaissement : moyen actif pour (pays, devise, mode de financement),
 *     prestataire actif et capable d'encaisser, montant dans les bornes ;
 *     ordre : priorité, puis coût estimé.
 *   - Paiement sortant : corridors actifs compatibles avec le transfert, hors
 *     corridors déjà essayés ; ordre : priorité, coût estimé (fixe + part
 *     proportionnelle arrondie au supérieur), délai de livraison.
 * La santé des prestataires (disjoncteur) et la trésorerie disponible sont
 * vérifiées ensuite, au moment de l'appel.
 */

export interface PayinRoute {
  readonly id: string;
  readonly provider: PaymentProviderName;
}

export interface PayoutRoute {
  readonly id: string;
  readonly provider: PaymentProviderName;
  readonly routeCode: string | null;
}

export async function payinRoutes(
  db: Queryable,
  params: { readonly country: string; readonly currency: string; readonly fundingMethod: FundingMethod; readonly amountMinor: bigint },
): Promise<readonly PayinRoute[]> {
  const result = await db.query<{ id: string; provider: PaymentProviderName }>(
    `SELECT m.id, m.provider::text AS provider
       FROM payments.payin_methods m
       JOIN payments.providers p ON p.code = m.provider
      WHERE m.is_enabled AND p.is_enabled AND p.supports_payin
        AND m.country = $1 AND m.currency = $2 AND m.funding_method = $3::transfers.funding_method
        AND $4::bigint BETWEEN m.min_amount AND m.max_amount
      ORDER BY m.priority, m.cost_fixed + ceil($4::numeric * m.cost_bps / 10000), m.created_at`,
    [params.country, params.currency, params.fundingMethod, params.amountMinor.toString()],
  );
  return result.rows;
}

export async function payoutRoutes(
  db: Queryable,
  params: {
    readonly sourceCountry: string;
    readonly destinationCountry: string;
    readonly currency: string;
    readonly payoutMethod: PayoutMethod;
    readonly amountMinor: bigint;
    readonly excludedCorridorIds: readonly string[];
  },
): Promise<readonly PayoutRoute[]> {
  const result = await db.query<{ id: string; provider: PaymentProviderName; provider_route_code: string | null }>(
    `SELECT c.id, c.provider::text AS provider, c.provider_route_code
       FROM payments.payout_corridors c
       JOIN payments.providers p ON p.code = c.provider
      WHERE c.is_enabled AND p.is_enabled AND p.supports_payout
        AND c.destination_country = $1 AND c.destination_currency = $2
        AND c.payout_method = $3::transfers.payout_method
        AND (c.source_country IS NULL OR c.source_country = $4)
        AND $5::bigint BETWEEN c.min_amount AND c.max_amount
        AND c.id <> ALL($6::uuid[])
      ORDER BY c.priority, c.cost_fixed + ceil($5::numeric * c.cost_bps / 10000), c.estimated_delivery_minutes, c.created_at`,
    [params.destinationCountry, params.currency, params.payoutMethod, params.sourceCountry, params.amountMinor.toString(), [...params.excludedCorridorIds]],
  );
  return result.rows.map((row) => ({ id: row.id, provider: row.provider, routeCode: row.provider_route_code }));
}

/**
 * Trésorerie disponible chez un prestataire dans une devise : solde de
 * préfinancement moins les paiements sortants ordonnés non encore réglés.
 * À appeler sous verrou consultatif (provider, devise) pour que deux
 * paiements concurrents ne consomment pas la même trésorerie.
 */
export async function availableFloat(db: Queryable, provider: PaymentProviderName, currency: string): Promise<bigint> {
  const result = await db.query<{ available: string }>(
    `SELECT (COALESCE(sum(b.balance) FILTER (WHERE a.account_type = 'provider_settlement'), 0)
           - COALESCE(sum(b.balance) FILTER (WHERE a.account_type = 'payout_clearing'), 0))::text AS available
       FROM ledger.accounts a
       JOIN ledger.account_balances b ON b.account_id = a.id
      WHERE a.provider = $1::payments.provider AND a.currency = $2
        AND a.account_type IN ('provider_settlement', 'payout_clearing')`,
    [provider, currency],
  );
  return BigInt(result.rows[0]?.available ?? "0");
}

export async function lockFloat(db: Queryable, provider: PaymentProviderName, currency: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payments:float:${provider}:${currency}`]);
}
