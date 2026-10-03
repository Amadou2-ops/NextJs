import type { DatabasePool } from "../../db/pool.js";
import type { Queryable } from "../../db/transaction.js";
import { AppError, NotFoundError, ServiceUnavailableError } from "../../lib/errors.js";
import {
  applyMarginToRate,
  convertMinor,
  crossRate,
  minimalSourceForTarget,
  Money,
  parseCurrencyCode,
  relativeDifferenceBps,
} from "../../lib/money.js";
import type { CurrencyCode, MoneyJson } from "../../lib/money.js";
import type { RateProviderName } from "./providers/types.js";

/**
 * Moteur de devis.
 *
 * Calcul (identique aux contrôles de la base, fx.quotes_validate) :
 *   taux moyen   = taux USD→destination / taux USD→source (taux croisé)
 *   taux client  = round(taux moyen × (10000 − marge) / 10000, 15)
 *   montant reçu = floor(montant envoyé × taux client), en unités mineures
 *   frais        = fixe + ceil(montant × pb / 10000), borné [min, max]
 *   total débité = montant envoyé + frais
 *
 * Garde-fous :
 *   - pays d'envoi ouvert, pays de réception ouvert, devises ouvertes ;
 *   - au moins un corridor de paiement actif couvrant le montant ;
 *   - taux de moins de FX_MAX_RATE_AGE ; si deux fournisseurs sont frais,
 *     leur écart doit rester sous FX_MAX_DIVERGENCE_BPS, sinon aucun devis ;
 *   - marge et barème de frais configurés obligatoires (pas de prix implicite).
 */

export type AmountType = "send" | "receive";
export type PayoutMethod = "bank_account" | "mobile_money" | "cash_pickup" | "card" | "wallet";
export type FundingMethod = "wallet_balance" | "card" | "bank_transfer" | "mobile_money" | "apple_pay" | "google_pay";

export interface QuoteRequest {
  readonly sourceCountry: string;
  readonly destinationCountry: string;
  readonly sourceCurrency: string;
  readonly destinationCurrency: string;
  readonly payoutMethod: PayoutMethod;
  readonly fundingMethod: FundingMethod;
  readonly amount: bigint;
  readonly amountType: AmountType;
}

export interface QuoteComputation {
  readonly sourceCountry: string;
  readonly destinationCountry: string;
  readonly sourceCurrency: CurrencyCode;
  readonly destinationCurrency: CurrencyCode;
  readonly payoutMethod: PayoutMethod;
  readonly fundingMethod: FundingMethod;
  readonly sourceAmount: Money;
  readonly fee: Money;
  readonly totalDebit: Money;
  readonly destinationAmount: Money;
  readonly midRate: string;
  readonly customerRate: string;
  readonly marginBps: number;
  readonly pricingRuleId: string | null;
  readonly feeScheduleId: string;
  readonly sourceLegSnapshotId: string | null;
  readonly destinationLegSnapshotId: string | null;
  readonly usdEquivalent: bigint;
  readonly estimatedDeliveryMinutes: number;
  readonly rateTimestamp: Date | null;
}

export interface QuoteView {
  readonly quoteId: string | null;
  readonly sourceCountry: string;
  readonly destinationCountry: string;
  readonly payoutMethod: PayoutMethod;
  readonly fundingMethod: FundingMethod;
  readonly sendAmount: MoneyJson;
  readonly fee: MoneyJson;
  readonly totalToPay: MoneyJson;
  readonly receiveAmount: MoneyJson;
  readonly exchangeRate: string;
  /** Délai de livraison du corridor le plus rapide ; null si plus aucun corridor ne sert ce devis. */
  readonly estimatedDeliveryMinutes: number | null;
  readonly rateTimestamp: string | null;
  readonly expiresAt: string | null;
}

export interface QuoteServiceOptions {
  readonly primaryProvider: RateProviderName;
  readonly maxRateAgeMs: number;
  readonly maxDivergenceBps: number;
  readonly quoteTtlSeconds: number;
}

interface CurrencyInfo {
  readonly code: string;
  readonly minor_units: number;
  readonly is_enabled: boolean;
}

interface UsdRate {
  readonly snapshotId: string;
  readonly rate: string;
  readonly timestamp: Date;
}

function unavailable(reason: string): AppError {
  return new AppError("VALIDATION_FAILED", 422, "Envoi indisponible", { detail: reason });
}

export class QuoteService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: QuoteServiceOptions,
  ) {}

  // ---------------------------------------------------------------------------
  // Taux
  // ---------------------------------------------------------------------------

  /** Taux USD→devise retenu : fournisseur principal s'il est frais, contrôle de divergence. */
  private async usdRate(db: Queryable, currency: string): Promise<UsdRate | null> {
    if (currency === "USD") return null;
    const result = await db.query<{ id: string; provider: RateProviderName; rate: string; provider_timestamp: Date; fresh: boolean }>(
      `SELECT id::text, provider, rate::text, provider_timestamp, provider_timestamp > now() - make_interval(secs => $2) AS fresh
         FROM fx.latest_usd_rates WHERE currency = $1`,
      [currency, this.options.maxRateAgeMs / 1000],
    );
    const fresh = result.rows.filter((row) => row.fresh);
    if (fresh.length === 0) {
      throw new ServiceUnavailableError("Les taux de change sont momentanément indisponibles. Réessayez plus tard.", undefined, 60);
    }
    const primary = fresh.find((row) => row.provider === this.options.primaryProvider) ?? fresh[0];
    if (primary === undefined) throw new Error("taux introuvable");
    for (const other of fresh) {
      if (other === primary) continue;
      const divergence = relativeDifferenceBps(other.rate, primary.rate);
      if (divergence > this.options.maxDivergenceBps) {
        throw new ServiceUnavailableError(
          "Les taux de change sont en cours de vérification. Réessayez dans quelques minutes.",
          new Error(`divergence ${divergence} pb sur ${currency} entre ${primary.provider} et ${other.provider}`),
          300,
        );
      }
    }
    return { snapshotId: primary.id, rate: primary.rate, timestamp: primary.provider_timestamp };
  }

  // ---------------------------------------------------------------------------
  // Tarification
  // ---------------------------------------------------------------------------

  private async marginRule(db: Queryable, source: string, destination: string): Promise<{ readonly id: string; readonly marginBps: number } | null> {
    const result = await db.query<{ id: string; margin_bps: number }>(
      `SELECT id, margin_bps FROM fx.pricing_rules
        WHERE (source_currency = $1 OR source_currency IS NULL)
          AND (destination_currency = $2 OR destination_currency IS NULL)
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
        ORDER BY priority DESC,
                 (source_currency IS NOT NULL)::int + (destination_currency IS NOT NULL)::int DESC,
                 created_at DESC
        LIMIT 1`,
      [source, destination],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, marginBps: row.margin_bps };
  }

  private async feeSchedule(
    db: Queryable,
    request: QuoteRequest,
  ): Promise<{ readonly id: string; readonly fixedFee: bigint; readonly bps: number; readonly minFee: bigint; readonly maxFee: bigint | null } | null> {
    const result = await db.query<{ id: string; fixed_fee: bigint; percentage_bps: number; min_fee: bigint; max_fee: bigint | null }>(
      `SELECT id, fixed_fee, percentage_bps, min_fee, max_fee FROM transfers.fee_schedules
        WHERE source_currency = $1
          AND (source_country = $2 OR source_country IS NULL)
          AND (destination_country = $3 OR destination_country IS NULL)
          AND (destination_currency = $4 OR destination_currency IS NULL)
          AND (payout_method = $5::transfers.payout_method OR payout_method IS NULL)
          AND (funding_method = $6::transfers.funding_method OR funding_method IS NULL)
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
        ORDER BY priority DESC,
                 (source_country IS NOT NULL)::int + (destination_country IS NOT NULL)::int
                   + (destination_currency IS NOT NULL)::int + (payout_method IS NOT NULL)::int
                   + (funding_method IS NOT NULL)::int DESC,
                 created_at DESC
        LIMIT 1`,
      [request.sourceCurrency, request.sourceCountry, request.destinationCountry, request.destinationCurrency, request.payoutMethod, request.fundingMethod],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, fixedFee: row.fixed_fee, bps: row.percentage_bps, minFee: row.min_fee, maxFee: row.max_fee };
  }

  /** Frais (identique à transfers.compute_fee) : fixe + ceil(montant × pb / 10000), bornés. */
  static computeFee(amount: Money, schedule: { readonly fixedFee: bigint; readonly bps: number; readonly minFee: bigint; readonly maxFee: bigint | null }): Money {
    let fee = schedule.fixedFee + amount.basisPoints(schedule.bps, "ceil").amountMinor;
    if (fee < schedule.minFee) fee = schedule.minFee;
    if (schedule.maxFee !== null && fee > schedule.maxFee) fee = schedule.maxFee;
    return Money.ofMinor(fee, amount.currency);
  }

  // ---------------------------------------------------------------------------
  // Calcul
  // ---------------------------------------------------------------------------

  async compute(db: Queryable, request: QuoteRequest): Promise<QuoteComputation> {
    const sourceCurrency = parseCurrencyCode(request.sourceCurrency);
    const destinationCurrency = parseCurrencyCode(request.destinationCurrency);
    if (request.amount <= 0n) throw unavailable("Le montant doit être positif.");

    const countries = await db.query<{ alpha2: string; can_send: boolean; can_receive: boolean; risk_level: string }>(
      "SELECT alpha2, can_send, can_receive, risk_level FROM ref.countries WHERE alpha2 = ANY($1::text[])",
      [[request.sourceCountry, request.destinationCountry]],
    );
    const source = countries.rows.find((row) => row.alpha2 === request.sourceCountry);
    const destination = countries.rows.find((row) => row.alpha2 === request.destinationCountry);
    if (source?.can_send !== true || source.risk_level === "prohibited") throw unavailable("L'envoi d'argent n'est pas disponible depuis ce pays.");
    if (destination?.can_receive !== true || destination.risk_level === "prohibited") throw unavailable("Ce pays de destination n'est pas desservi.");

    const currencies = await db.query<CurrencyInfo>("SELECT code, minor_units, is_enabled FROM ref.currencies WHERE code = ANY($1::text[])", [
      [sourceCurrency, destinationCurrency, "USD"],
    ]);
    const unitsOf = (code: string): CurrencyInfo => {
      const info = currencies.rows.find((row) => row.code === code);
      if (info === undefined) throw unavailable(`Devise inconnue : ${code}.`);
      return info;
    };
    const sourceInfo = unitsOf(sourceCurrency);
    const destinationInfo = unitsOf(destinationCurrency);
    const usdInfo = unitsOf("USD");
    if (!sourceInfo.is_enabled || !destinationInfo.is_enabled) throw unavailable("Cette devise n'est pas proposée.");

    const corridors = await db.query<{ min_amount: bigint; max_amount: bigint; estimated_delivery_minutes: number }>(
      `SELECT c.min_amount, c.max_amount, c.estimated_delivery_minutes
         FROM payments.payout_corridors c
         JOIN payments.providers p ON p.code = c.provider
        WHERE c.is_enabled AND p.is_enabled
          AND c.destination_country = $1 AND c.destination_currency = $2 AND c.payout_method = $3::transfers.payout_method
          AND (c.source_country IS NULL OR c.source_country = $4)`,
      [request.destinationCountry, destinationCurrency, request.payoutMethod, request.sourceCountry],
    );
    if (corridors.rows.length === 0) throw unavailable("Ce mode de réception n'est pas disponible pour ce pays.");

    // --- Taux ---------------------------------------------------------------
    const sourceLeg = await this.usdRate(db, sourceCurrency);
    const destinationLeg = await this.usdRate(db, destinationCurrency);
    let midRate: string;
    let marginBps: number;
    let pricingRuleId: string | null;
    if (sourceCurrency === destinationCurrency) {
      midRate = "1";
      marginBps = 0;
      pricingRuleId = null;
    } else {
      midRate = crossRate(sourceLeg?.rate ?? "1", destinationLeg?.rate ?? "1");
      const rule = await this.marginRule(db, sourceCurrency, destinationCurrency);
      if (rule === null) throw unavailable("Ce corridor n'est pas encore tarifé.");
      marginBps = rule.marginBps;
      pricingRuleId = rule.id;
    }
    const customerRate = sourceCurrency === destinationCurrency ? "1" : applyMarginToRate(midRate, marginBps);

    // --- Montants -----------------------------------------------------------
    const sourceMinor =
      request.amountType === "send"
        ? request.amount
        : minimalSourceForTarget(request.amount, customerRate, sourceInfo.minor_units, destinationInfo.minor_units);
    const sourceAmount = Money.ofMinor(sourceMinor, sourceCurrency);
    const destinationAmount = Money.ofMinor(convertMinor(sourceMinor, customerRate, sourceInfo.minor_units, destinationInfo.minor_units), destinationCurrency);
    if (destinationAmount.isZero()) throw unavailable("Le montant est trop faible.");

    const eligible = corridors.rows.filter((row) => destinationAmount.amountMinor >= row.min_amount && destinationAmount.amountMinor <= row.max_amount);
    if (eligible.length === 0) {
      const min = corridors.rows.reduce((value, row) => (row.min_amount < value ? row.min_amount : value), corridors.rows[0]?.min_amount ?? 0n);
      const max = corridors.rows.reduce((value, row) => (row.max_amount > value ? row.max_amount : value), 0n);
      throw new AppError("VALIDATION_FAILED", 422, "Montant hors limites", {
        detail: `Le montant reçu doit être compris entre ${min.toString()} et ${max.toString()} (unités mineures ${destinationCurrency}).`,
      });
    }

    const schedule = await this.feeSchedule(db, request);
    if (schedule === null) throw unavailable("Les frais de ce corridor ne sont pas encore définis.");
    const fee = QuoteService.computeFee(sourceAmount, schedule);
    const totalDebit = sourceAmount.add(fee);

    // Équivalent USD au taux moyen (plafonds KYC et règles AML).
    const usdEquivalent =
      sourceCurrency === "USD" || sourceLeg === null
        ? sourceMinor
        : convertMinor(sourceMinor, crossRate(sourceLeg.rate, "1"), sourceInfo.minor_units, usdInfo.minor_units);

    const rateTimestamps = [sourceLeg?.timestamp, destinationLeg?.timestamp].filter((value): value is Date => value !== undefined);
    return {
      sourceCountry: request.sourceCountry,
      destinationCountry: request.destinationCountry,
      sourceCurrency,
      destinationCurrency,
      payoutMethod: request.payoutMethod,
      fundingMethod: request.fundingMethod,
      sourceAmount,
      fee,
      totalDebit,
      destinationAmount,
      midRate,
      customerRate,
      marginBps,
      pricingRuleId,
      feeScheduleId: schedule.id,
      sourceLegSnapshotId: sourceLeg?.snapshotId ?? null,
      destinationLegSnapshotId: destinationLeg?.snapshotId ?? null,
      usdEquivalent,
      estimatedDeliveryMinutes: Math.min(...eligible.map((row) => row.estimated_delivery_minutes)),
      rateTimestamp: rateTimestamps.length === 0 ? null : new Date(Math.min(...rateTimestamps.map((date) => date.getTime()))),
    };
  }

  // ---------------------------------------------------------------------------
  // API publique du service
  // ---------------------------------------------------------------------------

  /** Simulation sans engagement (site public, avant connexion). */
  async estimate(request: QuoteRequest): Promise<QuoteView> {
    return present(await this.compute(this.pool, request), null, null);
  }

  /** Devis garanti pour un client, enregistré et consommable par un transfert. */
  async createQuote(userId: string, request: Omit<QuoteRequest, "sourceCountry">): Promise<QuoteView> {
    const residence = await this.pool.query<{ country_of_residence: string; status: string }>(
      "SELECT country_of_residence, status FROM identity.users WHERE id = $1",
      [userId],
    );
    const user = residence.rows[0];
    if (user === undefined) throw new NotFoundError("Client introuvable.");
    if (user.status !== "active") throw unavailable("Votre compte doit être actif pour obtenir un devis.");
    const computation = await this.compute(this.pool, { ...request, sourceCountry: user.country_of_residence });
    const inserted = await this.pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method,
                              source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate, margin_bps,
                              pricing_rule_id, source_leg_snapshot_id, destination_leg_snapshot_id, usd_equivalent, expires_at,
                              funding_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13, $14, $15, $16, $17,
               now() + make_interval(secs => $18), $19::transfers.funding_method)
       RETURNING id, expires_at`,
      [
        userId,
        computation.sourceCountry,
        computation.destinationCountry,
        computation.sourceCurrency,
        computation.destinationCurrency,
        computation.payoutMethod,
        computation.sourceAmount.amountMinor.toString(),
        computation.fee.amountMinor.toString(),
        computation.totalDebit.amountMinor.toString(),
        computation.destinationAmount.amountMinor.toString(),
        computation.midRate,
        computation.customerRate,
        computation.marginBps,
        computation.pricingRuleId,
        computation.sourceLegSnapshotId,
        computation.destinationLegSnapshotId,
        computation.usdEquivalent.toString(),
        this.options.quoteTtlSeconds,
        computation.fundingMethod,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("enregistrement du devis impossible");
    return present(computation, row.id, row.expires_at);
  }

  async getQuote(userId: string, quoteId: string): Promise<QuoteView & { readonly consumed: boolean }> {
    const result = await this.pool.query<{
      id: string; source_country: string; destination_country: string; source_currency: string; destination_currency: string;
      payout_method: PayoutMethod; funding_method: FundingMethod; source_amount: bigint; fee_amount: bigint; total_debit: bigint; destination_amount: bigint;
      customer_rate: string; expires_at: Date; consumed_at: Date | null; created_at: Date;
      rate_timestamp: Date | null; estimated_delivery_minutes: number | null;
    }>(
      `SELECT q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency, q.payout_method,
              q.funding_method, q.source_amount, q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate::text,
              q.expires_at, q.consumed_at, q.created_at,
              -- Horodatage du plus ancien des deux taux ayant servi au calcul (LEAST ignore les NULL).
              LEAST(sl.provider_timestamp, dl.provider_timestamp) AS rate_timestamp,
              (SELECT min(c.estimated_delivery_minutes)
                 FROM payments.payout_corridors c
                 JOIN payments.providers p ON p.code = c.provider
                WHERE c.is_enabled AND p.is_enabled
                  AND c.destination_country = q.destination_country AND c.destination_currency = q.destination_currency
                  AND c.payout_method = q.payout_method
                  AND (c.source_country IS NULL OR c.source_country = q.source_country)
                  AND q.destination_amount BETWEEN c.min_amount AND c.max_amount) AS estimated_delivery_minutes
         FROM fx.quotes q
         LEFT JOIN fx.rate_snapshots sl ON sl.id = q.source_leg_snapshot_id
         LEFT JOIN fx.rate_snapshots dl ON dl.id = q.destination_leg_snapshot_id
        WHERE q.id = $1 AND q.user_id = $2`,
      [quoteId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Devis introuvable.");
    const sourceCurrency = parseCurrencyCode(row.source_currency);
    const destinationCurrency = parseCurrencyCode(row.destination_currency);
    return {
      quoteId: row.id,
      sourceCountry: row.source_country,
      destinationCountry: row.destination_country,
      payoutMethod: row.payout_method,
      fundingMethod: row.funding_method,
      sendAmount: Money.ofMinor(row.source_amount, sourceCurrency).toJSON(),
      fee: Money.ofMinor(row.fee_amount, sourceCurrency).toJSON(),
      totalToPay: Money.ofMinor(row.total_debit, sourceCurrency).toJSON(),
      receiveAmount: Money.ofMinor(row.destination_amount, destinationCurrency).toJSON(),
      exchangeRate: trimRate(row.customer_rate),
      estimatedDeliveryMinutes: row.estimated_delivery_minutes,
      rateTimestamp: row.rate_timestamp?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString(),
      consumed: row.consumed_at !== null,
    };
  }
}

function trimRate(rate: string): string {
  return rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
}

function present(computation: QuoteComputation, quoteId: string | null, expiresAt: Date | null): QuoteView {
  return {
    quoteId,
    sourceCountry: computation.sourceCountry,
    destinationCountry: computation.destinationCountry,
    payoutMethod: computation.payoutMethod,
    fundingMethod: computation.fundingMethod,
    sendAmount: computation.sourceAmount.toJSON(),
    fee: computation.fee.toJSON(),
    totalToPay: computation.totalDebit.toJSON(),
    receiveAmount: computation.destinationAmount.toJSON(),
    exchangeRate: trimRate(computation.customerRate),
    estimatedDeliveryMinutes: computation.estimatedDeliveryMinutes,
    rateTimestamp: computation.rateTimestamp?.toISOString() ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
  };
}
