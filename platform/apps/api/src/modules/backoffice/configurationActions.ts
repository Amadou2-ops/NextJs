import { z } from "zod";

import type { DatabasePool } from "../../db/pool.js";
import type { TransactionClient } from "../../db/transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { defineApproval } from "./approvals.service.js";
import type { ApprovalDefinition, RegisteredApproval } from "./approvals.service.js";

/**
 * Paramétrage commercial et de routage, toujours en double validation :
 * marges de change, barèmes de frais, corridors de paiement sortant, moyens
 * d'encaissement, activation des prestataires et ouverture des pays.
 *
 * Le contenu d'une demande décrit la ligne EXACTE à écrire : la base
 * (migration 0026) refuse toute écriture qui s'en écarte, qui ne vient pas
 * de l'approbateur ou qui serait rétroactive. Chaque clé est présente (null
 * explicite) pour que cette comparaison soit complète.
 */

export const PAYOUT_METHODS = ["bank_account", "mobile_money", "cash_pickup", "card", "wallet"] as const;
export const FUNDING_METHODS = ["wallet_balance", "card", "bank_transfer", "mobile_money", "apple_pay", "google_pay"] as const;
export const PAYIN_FUNDING_METHODS = ["card", "bank_transfer", "mobile_money", "apple_pay", "google_pay"] as const;
export const PAYMENT_PROVIDERS = ["stripe", "flutterwave", "thunes"] as const;
export const COUNTRY_RISK_LEVELS = ["low", "medium", "high", "prohibited"] as const;

/** Délai maximal d'une date d'effet programmée. */
const MAX_SCHEDULE_DAYS = 90;
const DAY_MS = 86_400_000;

const currency = z.string().regex(/^[A-Z]{3}$/);
const country = z.string().regex(/^[A-Z]{2}$/);
/** Montant en unités mineures (chaîne : aucune perte de précision). */
const minor = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const positiveMinor = z.string().regex(/^[1-9][0-9]{0,17}$/);
const bps = (max: number): z.ZodNumber => z.number().int().min(0).max(max);
const priority = z.number().int().min(-1000).max(1000);
const instant = z.iso.datetime({ offset: true });

export const pricingRulePayloadSchema = z.strictObject({
  sourceCurrency: currency.nullable(),
  destinationCurrency: currency.nullable(),
  marginBps: bps(1500),
  priority,
  validFrom: instant.nullable(),
  validTo: instant.nullable(),
  replacesRuleId: z.uuid().nullable(),
});

export const feeSchedulePayloadSchema = z.strictObject({
  sourceCountry: country.nullable(),
  destinationCountry: country.nullable(),
  sourceCurrency: currency,
  destinationCurrency: currency.nullable(),
  payoutMethod: z.enum(PAYOUT_METHODS).nullable(),
  fundingMethod: z.enum(FUNDING_METHODS).nullable(),
  fixedFee: minor,
  percentageBps: bps(1000),
  minFee: minor,
  maxFee: minor.nullable(),
  priority,
  validFrom: instant.nullable(),
  validTo: instant.nullable(),
  replacesScheduleId: z.uuid().nullable(),
});

export const closeRulePayloadSchema = z.strictObject({ validTo: instant.nullable() });

const corridorParameters = {
  priority,
  minAmount: positiveMinor,
  maxAmount: positiveMinor,
  costFixed: minor,
  costBps: bps(1000),
  estimatedDeliveryMinutes: z.number().int().min(0).max(20160),
  isEnabled: z.boolean(),
  providerRouteCode: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable(),
};
export const corridorChangePayloadSchema = z.strictObject(corridorParameters);
export const corridorCreatePayloadSchema = z.strictObject({
  sourceCountry: country.nullable(),
  destinationCountry: country,
  destinationCurrency: currency,
  payoutMethod: z.enum(PAYOUT_METHODS),
  provider: z.enum(PAYMENT_PROVIDERS),
  ...corridorParameters,
});

const payinParameters = {
  priority,
  minAmount: positiveMinor,
  maxAmount: positiveMinor,
  costFixed: minor,
  costBps: bps(1000),
  isEnabled: z.boolean(),
};
export const payinChangePayloadSchema = z.strictObject(payinParameters);
export const payinCreatePayloadSchema = z.strictObject({
  country,
  currency,
  fundingMethod: z.enum(PAYIN_FUNDING_METHODS),
  provider: z.enum(PAYMENT_PROVIDERS),
  ...payinParameters,
});

export const providerPayloadSchema = z.strictObject({ isEnabled: z.boolean() });
export const countryPayloadSchema = z.strictObject({ canSend: z.boolean(), canReceive: z.boolean(), riskLevel: z.enum(COUNTRY_RISK_LEVELS) });

type PricingRulePayload = z.infer<typeof pricingRulePayloadSchema>;
type FeeSchedulePayload = z.infer<typeof feeSchedulePayloadSchema>;
type CorridorCreatePayload = z.infer<typeof corridorCreatePayloadSchema>;
type CorridorChangePayload = z.infer<typeof corridorChangePayloadSchema>;
type PayinCreatePayload = z.infer<typeof payinCreatePayloadSchema>;
type PayinChangePayload = z.infer<typeof payinChangePayloadSchema>;

// -----------------------------------------------------------------------------
// Contrôles communs
// -----------------------------------------------------------------------------

function invalid(path: string, message: string): ValidationError {
  return new ValidationError([{ path, message }]);
}

/** Fenêtre de validité : effet immédiat ou programmé (≤ 90 jours), fin postérieure. */
function assertValidity(validFrom: string | null, validTo: string | null): void {
  const now = Date.now();
  const from = validFrom === null ? now : Date.parse(validFrom);
  if (validFrom !== null && from <= now) throw invalid("body.validFrom", "date d'effet passée : laisser vide pour un effet immédiat");
  if (from > now + MAX_SCHEDULE_DAYS * DAY_MS) throw invalid("body.validFrom", `date d'effet au-delà de ${MAX_SCHEDULE_DAYS.toString()} jours`);
  if (validTo !== null && Date.parse(validTo) <= from) throw invalid("body.validTo", "fin de validité antérieure à la date d'effet");
}

function assertClosure(validTo: string | null): void {
  if (validTo === null) return;
  const to = Date.parse(validTo);
  if (to <= Date.now()) throw invalid("body.validTo", "date de fin passée : laisser vide pour une fin immédiate");
  if (to > Date.now() + MAX_SCHEDULE_DAYS * DAY_MS) throw invalid("body.validTo", `date de fin au-delà de ${MAX_SCHEDULE_DAYS.toString()} jours`);
}

function assertNewTarget(targetId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(targetId)) throw invalid("targetId", "identifiant de création invalide");
}

async function assertCurrencies(db: DatabasePool, codes: readonly (string | null)[]): Promise<void> {
  const wanted = [...new Set(codes.filter((code): code is string => code !== null))];
  if (wanted.length === 0) return;
  const result = await db.query<{ code: string }>("SELECT code FROM ref.currencies WHERE code = ANY($1::text[])", [wanted]);
  const known = new Set(result.rows.map((row) => row.code));
  for (const code of wanted) if (!known.has(code)) throw invalid("body", `devise inconnue : ${code}`);
}

async function assertCountries(db: DatabasePool, codes: readonly (string | null)[]): Promise<void> {
  const wanted = [...new Set(codes.filter((code): code is string => code !== null))];
  if (wanted.length === 0) return;
  const result = await db.query<{ alpha2: string }>("SELECT alpha2 FROM ref.countries WHERE alpha2 = ANY($1::text[])", [wanted]);
  const known = new Set(result.rows.map((row) => row.alpha2));
  for (const code of wanted) if (!known.has(code)) throw invalid("body", `pays inconnu : ${code}`);
}

function assertAmountRange(minAmount: string, maxAmount: string): void {
  if (BigInt(maxAmount) < BigInt(minAmount)) throw invalid("body.maxAmount", "plafond inférieur au plancher");
}

/** Une règle datée remplaçable : existe, porte sur le même périmètre, n'est pas close avant la date d'effet. */
async function assertReplaceable(
  db: DatabasePool,
  table: "fx.pricing_rules" | "transfers.fee_schedules",
  id: string,
  scope: Readonly<Record<string, string | null>>,
  effectiveFrom: string | null,
): Promise<void> {
  const columns = Object.keys(scope);
  const result = await db.query<Record<string, string | null> & { valid_from: Date; valid_to: Date | null }>(
    `SELECT ${columns.join(", ")}, valid_from, valid_to FROM ${table} WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError("Règle à remplacer introuvable.");
  for (const column of columns) {
    if ((row[column] ?? null) !== scope[column]) throw invalid("body.replaces", "la règle remplacée porte sur un autre périmètre");
  }
  const from = effectiveFrom === null ? Date.now() : Date.parse(effectiveFrom);
  if (row.valid_from.getTime() >= from) throw invalid("body.replaces", "la règle remplacée n'est pas encore en vigueur à cette date");
  if (row.valid_to !== null && row.valid_to.getTime() <= from) throw new ConflictError("CONFLICT", "La règle remplacée prend déjà fin avant cette date.");
}

async function assertClosable(db: DatabasePool, table: "fx.pricing_rules" | "transfers.fee_schedules", id: string, validTo: string | null): Promise<void> {
  const result = await db.query<{ valid_from: Date; valid_to: Date | null }>(`SELECT valid_from, valid_to FROM ${table} WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError("Règle introuvable.");
  const end = validTo === null ? Date.now() : Date.parse(validTo);
  if (row.valid_to !== null && row.valid_to.getTime() <= end) throw new ConflictError("CONFLICT", "Cette règle prend déjà fin à cette date ou avant.");
  if (row.valid_from.getTime() >= end) throw invalid("body.validTo", "fin antérieure à l'entrée en vigueur de la règle");
}

/** À l'exécution : une date approuvée entre-temps dépassée exige une nouvelle demande (jamais d'effet rétroactif). */
function assertStillAhead(value: string | null, label: string): void {
  if (value !== null && Date.parse(value) <= Date.now()) {
    throw new ConflictError("CONFLICT", `La ${label} de la demande est dépassée : renouvelez la demande.`);
  }
}

async function requesterOf(client: TransactionClient, requestId: string): Promise<string> {
  const result = await client.query<{ requested_by_admin_id: string }>("SELECT requested_by_admin_id FROM backoffice.approval_requests WHERE id = $1", [requestId]);
  const requester = result.rows[0]?.requested_by_admin_id;
  if (requester === undefined) throw new Error("demande d'approbation introuvable");
  return requester;
}

/** Un seul corridor ou moyen par combinaison (index unique de la base) : message clair avant la demande. */
async function assertUnique(db: DatabasePool, sql: string, params: readonly unknown[], message: string): Promise<void> {
  const existing = await db.query(sql, [...params]);
  if (existing.rowCount !== 0) throw new ConflictError("CONFLICT", message);
}

// -----------------------------------------------------------------------------
// Catalogue
// -----------------------------------------------------------------------------

export function configurationApprovals(): ReadonlyMap<string, RegisteredApproval> {
  const createPricingRule: ApprovalDefinition<PricingRulePayload> = {
    permission: "pricing:manage",
    targetType: "pricing_rule",
    schema: pricingRulePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertNewTarget(targetId);
      assertValidity(payload.validFrom, payload.validTo);
      await assertCurrencies(db, [payload.sourceCurrency, payload.destinationCurrency]);
      if (payload.sourceCurrency !== null && payload.sourceCurrency === payload.destinationCurrency) {
        throw invalid("body.destinationCurrency", "une marge porte sur deux devises différentes (aucune marge sans conversion)");
      }
      if (payload.replacesRuleId !== null) {
        await assertReplaceable(
          db,
          "fx.pricing_rules",
          payload.replacesRuleId,
          { source_currency: payload.sourceCurrency, destination_currency: payload.destinationCurrency },
          payload.validFrom,
        );
      }
    },
    execute: async (client, request) => {
      const { payload } = request;
      assertStillAhead(payload.validFrom, "date d'effet");
      const requester = await requesterOf(client, request.id);
      await client.query(
        `INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, valid_from, valid_to, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7::timestamptz, $8)`,
        [request.targetId, payload.sourceCurrency, payload.destinationCurrency, payload.marginBps, payload.priority, payload.validFrom, payload.validTo, requester],
      );
      if (payload.replacesRuleId !== null) {
        const closed = await client.query(
          "UPDATE fx.pricing_rules SET valid_to = COALESCE($2::timestamptz, now()) WHERE id = $1 AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))",
          [payload.replacesRuleId, payload.validFrom],
        );
        if (closed.rowCount !== 1) throw new ConflictError("CONFLICT", "La marge remplacée a changé depuis la demande.");
      }
      return { result: { pricingRuleId: request.targetId, replacedRuleId: payload.replacesRuleId } };
    },
  };

  const closePricingRule: ApprovalDefinition<z.infer<typeof closeRulePayloadSchema>> = {
    permission: "pricing:manage",
    targetType: "pricing_rule",
    schema: closeRulePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertClosure(payload.validTo);
      await assertClosable(db, "fx.pricing_rules", targetId, payload.validTo);
    },
    execute: async (client, request) => {
      assertStillAhead(request.payload.validTo, "date de fin");
      const closed = await client.query(
        "UPDATE fx.pricing_rules SET valid_to = COALESCE($2::timestamptz, now()) WHERE id = $1 AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))",
        [request.targetId, request.payload.validTo],
      );
      if (closed.rowCount !== 1) throw new ConflictError("CONFLICT", "Cette marge prend déjà fin à cette date ou avant.");
      return { result: { pricingRuleId: request.targetId } };
    },
  };

  const createFeeSchedule: ApprovalDefinition<FeeSchedulePayload> = {
    permission: "pricing:manage",
    targetType: "fee_schedule",
    schema: feeSchedulePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertNewTarget(targetId);
      assertValidity(payload.validFrom, payload.validTo);
      await assertCurrencies(db, [payload.sourceCurrency, payload.destinationCurrency]);
      await assertCountries(db, [payload.sourceCountry, payload.destinationCountry]);
      if (payload.maxFee !== null && BigInt(payload.maxFee) < BigInt(payload.minFee)) throw invalid("body.maxFee", "plafond de frais inférieur au minimum");
      if (payload.replacesScheduleId !== null) {
        await assertReplaceable(
          db,
          "transfers.fee_schedules",
          payload.replacesScheduleId,
          {
            source_country: payload.sourceCountry,
            destination_country: payload.destinationCountry,
            source_currency: payload.sourceCurrency,
            destination_currency: payload.destinationCurrency,
            payout_method: payload.payoutMethod,
            funding_method: payload.fundingMethod,
          },
          payload.validFrom,
        );
      }
    },
    execute: async (client, request) => {
      const { payload } = request;
      assertStillAhead(payload.validFrom, "date d'effet");
      const requester = await requesterOf(client, request.id);
      await client.query(
        `INSERT INTO transfers.fee_schedules (id, source_country, destination_country, source_currency, destination_currency, payout_method,
                                              funding_method, fixed_fee, percentage_bps, min_fee, max_fee, priority, valid_from, valid_to,
                                              created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6::transfers.payout_method, $7::transfers.funding_method, $8::bigint, $9, $10::bigint, $11::bigint, $12,
                 COALESCE($13::timestamptz, now()), $14::timestamptz, $15)`,
        [
          request.targetId,
          payload.sourceCountry,
          payload.destinationCountry,
          payload.sourceCurrency,
          payload.destinationCurrency,
          payload.payoutMethod,
          payload.fundingMethod,
          payload.fixedFee,
          payload.percentageBps,
          payload.minFee,
          payload.maxFee,
          payload.priority,
          payload.validFrom,
          payload.validTo,
          requester,
        ],
      );
      if (payload.replacesScheduleId !== null) {
        const closed = await client.query(
          "UPDATE transfers.fee_schedules SET valid_to = COALESCE($2::timestamptz, now()) WHERE id = $1 AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))",
          [payload.replacesScheduleId, payload.validFrom],
        );
        if (closed.rowCount !== 1) throw new ConflictError("CONFLICT", "Le barème remplacé a changé depuis la demande.");
      }
      return { result: { feeScheduleId: request.targetId, replacedScheduleId: payload.replacesScheduleId } };
    },
  };

  const closeFeeSchedule: ApprovalDefinition<z.infer<typeof closeRulePayloadSchema>> = {
    permission: "pricing:manage",
    targetType: "fee_schedule",
    schema: closeRulePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertClosure(payload.validTo);
      await assertClosable(db, "transfers.fee_schedules", targetId, payload.validTo);
    },
    execute: async (client, request) => {
      assertStillAhead(request.payload.validTo, "date de fin");
      const closed = await client.query(
        "UPDATE transfers.fee_schedules SET valid_to = COALESCE($2::timestamptz, now()) WHERE id = $1 AND (valid_to IS NULL OR valid_to > COALESCE($2::timestamptz, now()))",
        [request.targetId, request.payload.validTo],
      );
      if (closed.rowCount !== 1) throw new ConflictError("CONFLICT", "Ce barème prend déjà fin à cette date ou avant.");
      return { result: { feeScheduleId: request.targetId } };
    },
  };

  const createPayoutCorridor: ApprovalDefinition<CorridorCreatePayload> = {
    permission: "routing:manage",
    targetType: "payout_corridor",
    schema: corridorCreatePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertNewTarget(targetId);
      assertAmountRange(payload.minAmount, payload.maxAmount);
      if (payload.sourceCountry === payload.destinationCountry) throw invalid("body.destinationCountry", "pays d'origine et de destination identiques");
      if (payload.provider === "thunes" && payload.providerRouteCode === null) throw invalid("body.providerRouteCode", "code du payeur Thunes requis");
      await assertCountries(db, [payload.sourceCountry, payload.destinationCountry]);
      await assertCurrencies(db, [payload.destinationCurrency]);
      await assertUnique(
        db,
        `SELECT 1 FROM payments.payout_corridors
          WHERE source_country IS NOT DISTINCT FROM $1 AND destination_country = $2 AND destination_currency = $3
            AND payout_method = $4::transfers.payout_method AND provider = $5::payments.provider`,
        [payload.sourceCountry, payload.destinationCountry, payload.destinationCurrency, payload.payoutMethod, payload.provider],
        "Ce corridor existe déjà pour ce prestataire : modifiez-le.",
      );
    },
    execute: async (client, request) => {
      const p = request.payload;
      await client.query(
        `INSERT INTO payments.payout_corridors (id, source_country, destination_country, destination_currency, payout_method, provider, priority,
                                                min_amount, max_amount, cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled, provider_route_code)
         VALUES ($1, $2, $3, $4, $5::transfers.payout_method, $6::payments.provider, $7, $8::bigint, $9::bigint, $10::bigint, $11, $12, $13, $14)`,
        [request.targetId, p.sourceCountry, p.destinationCountry, p.destinationCurrency, p.payoutMethod, p.provider, p.priority, p.minAmount, p.maxAmount, p.costFixed, p.costBps, p.estimatedDeliveryMinutes, p.isEnabled, p.providerRouteCode],
      );
      return { result: { corridorId: request.targetId } };
    },
  };

  const updatePayoutCorridor: ApprovalDefinition<CorridorChangePayload> = {
    permission: "routing:manage",
    targetType: "payout_corridor",
    schema: corridorChangePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertAmountRange(payload.minAmount, payload.maxAmount);
      const result = await db.query<{ provider: string }>("SELECT provider::text FROM payments.payout_corridors WHERE id = $1", [targetId]);
      const corridor = result.rows[0];
      if (corridor === undefined) throw new NotFoundError("Corridor introuvable.");
      if (corridor.provider === "thunes" && payload.providerRouteCode === null) throw invalid("body.providerRouteCode", "code du payeur Thunes requis");
    },
    execute: async (client, request) => {
      const p = request.payload;
      const updated = await client.query(
        `UPDATE payments.payout_corridors
            SET priority = $2, min_amount = $3::bigint, max_amount = $4::bigint, cost_fixed = $5::bigint, cost_bps = $6,
                estimated_delivery_minutes = $7, is_enabled = $8, provider_route_code = $9
          WHERE id = $1`,
        [request.targetId, p.priority, p.minAmount, p.maxAmount, p.costFixed, p.costBps, p.estimatedDeliveryMinutes, p.isEnabled, p.providerRouteCode],
      );
      if (updated.rowCount !== 1) throw new NotFoundError("Corridor introuvable.");
      return { result: { corridorId: request.targetId, isEnabled: p.isEnabled } };
    },
  };

  const createPayinMethod: ApprovalDefinition<PayinCreatePayload> = {
    permission: "routing:manage",
    targetType: "payin_method",
    schema: payinCreatePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertNewTarget(targetId);
      assertAmountRange(payload.minAmount, payload.maxAmount);
      await assertCountries(db, [payload.country]);
      await assertCurrencies(db, [payload.currency]);
      await assertUnique(
        db,
        `SELECT 1 FROM payments.payin_methods
          WHERE country = $1 AND currency = $2 AND funding_method = $3::transfers.funding_method AND provider = $4::payments.provider`,
        [payload.country, payload.currency, payload.fundingMethod, payload.provider],
        "Ce moyen d'encaissement existe déjà pour ce prestataire : modifiez-le.",
      );
    },
    execute: async (client, request) => {
      const p = request.payload;
      await client.query(
        `INSERT INTO payments.payin_methods (id, country, currency, funding_method, provider, priority, min_amount, max_amount, cost_fixed, cost_bps, is_enabled)
         VALUES ($1, $2, $3, $4::transfers.funding_method, $5::payments.provider, $6, $7::bigint, $8::bigint, $9::bigint, $10, $11)`,
        [request.targetId, p.country, p.currency, p.fundingMethod, p.provider, p.priority, p.minAmount, p.maxAmount, p.costFixed, p.costBps, p.isEnabled],
      );
      return { result: { payinMethodId: request.targetId } };
    },
  };

  const updatePayinMethod: ApprovalDefinition<PayinChangePayload> = {
    permission: "routing:manage",
    targetType: "payin_method",
    schema: payinChangePayloadSchema,
    prepare: async (db, targetId, payload) => {
      assertAmountRange(payload.minAmount, payload.maxAmount);
      const result = await db.query("SELECT 1 FROM payments.payin_methods WHERE id = $1", [targetId]);
      if (result.rowCount === 0) throw new NotFoundError("Moyen d'encaissement introuvable.");
    },
    execute: async (client, request) => {
      const p = request.payload;
      const updated = await client.query(
        `UPDATE payments.payin_methods
            SET priority = $2, min_amount = $3::bigint, max_amount = $4::bigint, cost_fixed = $5::bigint, cost_bps = $6, is_enabled = $7
          WHERE id = $1`,
        [request.targetId, p.priority, p.minAmount, p.maxAmount, p.costFixed, p.costBps, p.isEnabled],
      );
      if (updated.rowCount !== 1) throw new NotFoundError("Moyen d'encaissement introuvable.");
      return { result: { payinMethodId: request.targetId, isEnabled: p.isEnabled } };
    },
  };

  const setPaymentProvider: ApprovalDefinition<z.infer<typeof providerPayloadSchema>> = {
    permission: "routing:manage",
    targetType: "payment_provider",
    schema: providerPayloadSchema,
    prepare: async (db, targetId, payload) => {
      const result = await db.query<{ is_enabled: boolean }>("SELECT is_enabled FROM payments.providers WHERE code::text = $1", [targetId]);
      const provider = result.rows[0];
      if (provider === undefined) throw new NotFoundError("Prestataire introuvable.");
      if (provider.is_enabled === payload.isEnabled) throw new ConflictError("CONFLICT", payload.isEnabled ? "Ce prestataire est déjà activé." : "Ce prestataire est déjà désactivé.");
    },
    execute: async (client, request) => {
      const updated = await client.query("UPDATE payments.providers SET is_enabled = $2 WHERE code::text = $1 AND is_enabled <> $2", [request.targetId, request.payload.isEnabled]);
      if (updated.rowCount !== 1) throw new ConflictError("CONFLICT", "L'état du prestataire a changé depuis la demande.");
      return { result: { provider: request.targetId, isEnabled: request.payload.isEnabled } };
    },
  };

  const updateCountry: ApprovalDefinition<z.infer<typeof countryPayloadSchema>> = {
    permission: "countries:manage",
    targetType: "country",
    schema: countryPayloadSchema,
    prepare: async (db, targetId, payload) => {
      if (payload.riskLevel === "prohibited" && (payload.canSend || payload.canReceive)) {
        throw invalid("body.riskLevel", "un pays interdit reste fermé à l'envoi et à la réception");
      }
      const result = await db.query<{ can_send: boolean; can_receive: boolean; risk_level: string }>(
        "SELECT can_send, can_receive, risk_level::text FROM ref.countries WHERE alpha2 = $1",
        [targetId],
      );
      const current = result.rows[0];
      if (current === undefined) throw new NotFoundError("Pays introuvable.");
      if (current.can_send === payload.canSend && current.can_receive === payload.canReceive && current.risk_level === payload.riskLevel) {
        throw new ConflictError("CONFLICT", "Aucun changement par rapport au paramétrage actuel.");
      }
    },
    execute: async (client, request) => {
      const p = request.payload;
      const updated = await client.query(
        "UPDATE ref.countries SET can_send = $2, can_receive = $3, risk_level = $4::ref.country_risk_level, risk_reviewed_at = now() WHERE alpha2 = $1",
        [request.targetId, p.canSend, p.canReceive, p.riskLevel],
      );
      if (updated.rowCount !== 1) throw new NotFoundError("Pays introuvable.");
      return { result: { country: request.targetId, canSend: p.canSend, canReceive: p.canReceive, riskLevel: p.riskLevel } };
    },
  };

  return new Map<string, RegisteredApproval>([
    ["create_pricing_rule", defineApproval(createPricingRule)],
    ["close_pricing_rule", defineApproval(closePricingRule)],
    ["create_fee_schedule", defineApproval(createFeeSchedule)],
    ["close_fee_schedule", defineApproval(closeFeeSchedule)],
    ["create_payout_corridor", defineApproval(createPayoutCorridor)],
    ["update_payout_corridor", defineApproval(updatePayoutCorridor)],
    ["create_payin_method", defineApproval(createPayinMethod)],
    ["update_payin_method", defineApproval(updatePayinMethod)],
    ["set_payment_provider", defineApproval(setPaymentProvider)],
    ["update_country", defineApproval(updateCountry)],
  ]);
}
