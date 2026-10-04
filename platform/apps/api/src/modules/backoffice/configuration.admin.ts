import type { DatabasePool } from "../../db/pool.js";
import type { QuoteRequest, QuoteService } from "../fx/quote.service.js";

/**
 * Paramétrage vu du back-office (configuration:read) : marges de change,
 * barèmes de frais, corridors de paiement sortant, moyens d'encaissement,
 * prestataires et pays. Chaque élément indique la demande de modification
 * en attente qui le vise, le cas échéant. Les modifications passent par la
 * double validation (configurationActions.ts).
 */

export type RuleState = "scheduled" | "active" | "ended";
export type RuleFilter = "current" | "all";

interface PendingRef {
  readonly pending_request_id: string | null;
}

/**
 * Demande en cours (en attente ou approuvée non exécutée) visant la cible,
 * y compris, pour une règle datée, la création d'une règle qui la remplace.
 */
function pendingJoin(targetType: string, targetExpression: string, replacesKey?: string): string {
  const replaces = replacesKey === undefined ? "" : ` OR r.payload ->> '${replacesKey}' = ${targetExpression}`;
  return `LEFT JOIN LATERAL (
            SELECT r.id AS pending_request_id FROM backoffice.approval_requests r
             WHERE r.target_type = '${targetType}' AND (r.target_id = ${targetExpression}${replaces})
               AND r.status IN ('pending', 'approved') AND r.expires_at > now()
             ORDER BY r.requested_at DESC LIMIT 1) pending ON true`;
}

function ruleState(validFrom: Date, validTo: Date | null, now: Date): RuleState {
  if (validFrom > now) return "scheduled";
  if (validTo !== null && validTo <= now) return "ended";
  return "active";
}

interface DatedRow extends PendingRef {
  id: string;
  priority: number;
  valid_from: Date;
  valid_to: Date | null;
  created_by_admin_id: string | null;
  created_by_name: string | null;
  created_at: Date;
  db_now: Date;
}

function presentDated(row: DatedRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    priority: row.priority,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    state: ruleState(row.valid_from, row.valid_to, row.db_now),
    createdBy: row.created_by_admin_id === null ? null : { id: row.created_by_admin_id, name: row.created_by_name ?? "" },
    createdAt: row.created_at.toISOString(),
    pendingRequestId: row.pending_request_id,
  };
}

const CURRENT_ONLY = "(x.valid_to IS NULL OR x.valid_to > now())";

interface PricingRuleRow extends DatedRow {
  source_currency: string | null;
  destination_currency: string | null;
  margin_bps: number;
}

interface FeeScheduleRow extends DatedRow {
  source_country: string | null;
  destination_country: string | null;
  source_currency: string;
  destination_currency: string | null;
  payout_method: string | null;
  funding_method: string | null;
  fixed_fee: string;
  percentage_bps: number;
  min_fee: string;
  max_fee: string | null;
}

interface CorridorRow extends PendingRef {
  id: string;
  source_country: string | null;
  destination_country: string;
  destination_currency: string;
  payout_method: string;
  provider: string;
  provider_enabled: boolean;
  circuit_state: string | null;
  priority: number;
  min_amount: string;
  max_amount: string;
  cost_fixed: string;
  cost_bps: number;
  estimated_delivery_minutes: number;
  is_enabled: boolean;
  provider_route_code: string | null;
  updated_at: Date;
}

interface PayinRow extends PendingRef {
  id: string;
  country: string;
  currency: string;
  funding_method: string;
  provider: string;
  provider_enabled: boolean;
  circuit_state: string | null;
  priority: number;
  min_amount: string;
  max_amount: string;
  cost_fixed: string;
  cost_bps: number;
  is_enabled: boolean;
  updated_at: Date;
}

interface ProviderRow extends PendingRef {
  code: string;
  display_name: string;
  environment: string;
  is_enabled: boolean;
  supports_payin: boolean;
  supports_payout: boolean;
  circuit_state: string | null;
  updated_at: Date;
}

interface CountryRow extends PendingRef {
  alpha2: string;
  name_fr: string;
  default_currency: string | null;
  risk_level: string;
  can_send: boolean;
  can_receive: boolean;
  risk_reviewed_at: Date | null;
}

export class ConfigurationAdminService {
  constructor(private readonly deps: { readonly pool: DatabasePool; readonly quotes: QuoteService }) {}

  async pricingRules(filter: RuleFilter): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<PricingRuleRow>(
      `SELECT x.id, x.source_currency, x.destination_currency, x.margin_bps, x.priority, x.valid_from, x.valid_to,
              x.created_by_admin_id, a.full_name AS created_by_name, x.created_at, now() AS db_now, pending.pending_request_id
         FROM fx.pricing_rules x
         LEFT JOIN backoffice.admin_users a ON a.id = x.created_by_admin_id
         ${pendingJoin("pricing_rule", "x.id::text", "replacesRuleId")}
        WHERE $1 = 'all' OR ${CURRENT_ONLY}
        ORDER BY x.source_currency NULLS LAST, x.destination_currency NULLS LAST, x.priority DESC, x.valid_from DESC
        LIMIT 500`,
      [filter],
    );
    return {
      items: result.rows.map((row) => ({
        ...presentDated(row),
        sourceCurrency: row.source_currency,
        destinationCurrency: row.destination_currency,
        marginBps: row.margin_bps,
      })),
    };
  }

  async feeSchedules(filter: RuleFilter): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<FeeScheduleRow>(
      `SELECT x.id, x.source_country, x.destination_country, x.source_currency, x.destination_currency, x.payout_method::text,
              x.funding_method::text, x.fixed_fee::text, x.percentage_bps, x.min_fee::text, x.max_fee::text, x.priority, x.valid_from,
              x.valid_to, x.created_by_admin_id, a.full_name AS created_by_name, x.created_at, now() AS db_now, pending.pending_request_id
         FROM transfers.fee_schedules x
         LEFT JOIN backoffice.admin_users a ON a.id = x.created_by_admin_id
         ${pendingJoin("fee_schedule", "x.id::text", "replacesScheduleId")}
        WHERE $1 = 'all' OR ${CURRENT_ONLY}
        ORDER BY x.source_currency, x.destination_country NULLS LAST, x.priority DESC, x.valid_from DESC
        LIMIT 500`,
      [filter],
    );
    return {
      items: result.rows.map((row) => ({
        ...presentDated(row),
        sourceCountry: row.source_country,
        destinationCountry: row.destination_country,
        sourceCurrency: row.source_currency,
        destinationCurrency: row.destination_currency,
        payoutMethod: row.payout_method,
        fundingMethod: row.funding_method,
        fixedFee: row.fixed_fee,
        percentageBps: row.percentage_bps,
        minFee: row.min_fee,
        maxFee: row.max_fee,
      })),
    };
  }

  async payoutCorridors(): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<CorridorRow>(
      `SELECT c.id, c.source_country, c.destination_country, c.destination_currency, c.payout_method::text, c.provider::text,
              p.is_enabled AS provider_enabled, h.circuit_state::text, c.priority, c.min_amount::text, c.max_amount::text,
              c.cost_fixed::text, c.cost_bps, c.estimated_delivery_minutes, c.is_enabled, c.provider_route_code, c.updated_at,
              pending.pending_request_id
         FROM payments.payout_corridors c
         JOIN payments.providers p ON p.code = c.provider
         LEFT JOIN payments.provider_health h ON h.provider = c.provider
         ${pendingJoin("payout_corridor", "c.id::text")}
        ORDER BY c.destination_country, c.destination_currency, c.payout_method, c.priority DESC, c.provider`,
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        sourceCountry: row.source_country,
        destinationCountry: row.destination_country,
        destinationCurrency: row.destination_currency,
        payoutMethod: row.payout_method,
        provider: row.provider,
        providerEnabled: row.provider_enabled,
        circuitState: row.circuit_state ?? "closed",
        priority: row.priority,
        minAmount: row.min_amount,
        maxAmount: row.max_amount,
        costFixed: row.cost_fixed,
        costBps: row.cost_bps,
        estimatedDeliveryMinutes: row.estimated_delivery_minutes,
        isEnabled: row.is_enabled,
        providerRouteCode: row.provider_route_code,
        updatedAt: row.updated_at.toISOString(),
        pendingRequestId: row.pending_request_id,
      })),
    };
  }

  async payinMethods(): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<PayinRow>(
      `SELECT m.id, m.country, m.currency, m.funding_method::text, m.provider::text, p.is_enabled AS provider_enabled,
              h.circuit_state::text, m.priority, m.min_amount::text, m.max_amount::text, m.cost_fixed::text, m.cost_bps, m.is_enabled,
              m.updated_at, pending.pending_request_id
         FROM payments.payin_methods m
         JOIN payments.providers p ON p.code = m.provider
         LEFT JOIN payments.provider_health h ON h.provider = m.provider
         ${pendingJoin("payin_method", "m.id::text")}
        ORDER BY m.country, m.currency, m.funding_method, m.priority DESC, m.provider`,
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        country: row.country,
        currency: row.currency,
        fundingMethod: row.funding_method,
        provider: row.provider,
        providerEnabled: row.provider_enabled,
        circuitState: row.circuit_state ?? "closed",
        priority: row.priority,
        minAmount: row.min_amount,
        maxAmount: row.max_amount,
        costFixed: row.cost_fixed,
        costBps: row.cost_bps,
        isEnabled: row.is_enabled,
        updatedAt: row.updated_at.toISOString(),
        pendingRequestId: row.pending_request_id,
      })),
    };
  }

  async providers(): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<ProviderRow>(
      `SELECT p.code::text, p.display_name, p.environment::text, p.is_enabled, p.supports_payin, p.supports_payout,
              h.circuit_state::text, p.updated_at, pending.pending_request_id
         FROM payments.providers p
         LEFT JOIN payments.provider_health h ON h.provider = p.code
         ${pendingJoin("payment_provider", "p.code::text")}
        ORDER BY p.code`,
    );
    return {
      items: result.rows.map((row) => ({
        code: row.code,
        displayName: row.display_name,
        environment: row.environment,
        isEnabled: row.is_enabled,
        supportsPayin: row.supports_payin,
        supportsPayout: row.supports_payout,
        circuitState: row.circuit_state ?? "closed",
        updatedAt: row.updated_at.toISOString(),
        pendingRequestId: row.pending_request_id,
      })),
    };
  }

  async countries(filter: "open" | "all"): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.deps.pool.query<CountryRow>(
      `SELECT c.alpha2, c.name_fr, c.default_currency, c.risk_level::text, c.can_send, c.can_receive, c.risk_reviewed_at,
              pending.pending_request_id
         FROM ref.countries c
         ${pendingJoin("country", "c.alpha2::text")}
        WHERE $1 = 'all' OR c.can_send OR c.can_receive OR pending.pending_request_id IS NOT NULL
        ORDER BY c.name_fr`,
      [filter],
    );
    return {
      items: result.rows.map((row) => ({
        code: row.alpha2,
        name: row.name_fr,
        defaultCurrency: row.default_currency,
        riskLevel: row.risk_level,
        canSend: row.can_send,
        canReceive: row.can_receive,
        riskReviewedAt: row.risk_reviewed_at?.toISOString() ?? null,
        pendingRequestId: row.pending_request_id,
      })),
    };
  }

  /**
   * Prix qu'obtiendrait un client à cet instant (sans devis enregistré) et
   * règles appliquées : vérification d'un paramétrage après son exécution.
   */
  async previewQuote(request: QuoteRequest): Promise<Readonly<Record<string, unknown>>> {
    const computation = await this.deps.quotes.compute(this.deps.pool, request);
    return {
      sendAmount: computation.sourceAmount.toJSON(),
      fee: computation.fee.toJSON(),
      totalToPay: computation.totalDebit.toJSON(),
      receiveAmount: computation.destinationAmount.toJSON(),
      midRate: computation.midRate,
      customerRate: computation.customerRate,
      marginBps: computation.marginBps,
      pricingRuleId: computation.pricingRuleId,
      feeScheduleId: computation.feeScheduleId,
      estimatedDeliveryMinutes: computation.estimatedDeliveryMinutes,
      rateTimestamp: computation.rateTimestamp?.toISOString() ?? null,
    };
  }
}
