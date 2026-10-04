"use server";

import { amountToMinor, FUNDING_METHODS, PAYIN_FUNDING_METHODS, PAYOUT_METHODS, parisLocalToIso, percentToBps, PROVIDERS, RISK_LEVELS } from "@/lib/configuration";
import { justification } from "@/lib/forms";
import type { Approval } from "@/lib/types";
import { z } from "@/lib/zod";
import type { AdminActionState } from "@/server/actionState";
import { actionApi } from "@/server/context";
import { invalidTarget, mutation, validId } from "@/server/mutation";

/**
 * Demandes de modification du paramétrage, toutes à double validation. La
 * saisie (pourcentages, montants décimaux, heures de Paris) est convertie
 * ici en valeurs exactes ; l'API et la base revalident tout, et la base
 * n'écrira que la ligne décrite par la demande approuvée.
 */

const SENT = "Demande créée : un second membre habilité doit l'approuver avant toute modification.";

/** Champ facultatif : vide = null. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" || value === undefined ? null : value), schema.nullable());
}

const currency = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, "code ISO à 3 lettres (ex. EUR)"));
const country = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/, "code ISO à 2 lettres (ex. SN)"));
const integer = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,6}$/, "nombre entier attendu")
    .transform(Number)
    .pipe(z.number().int().min(min, `${min.toString()} au minimum`).max(max, `${max.toString()} au maximum`));
const percent = z
  .string()
  .transform((value, ctx) => {
    const bps = percentToBps(value);
    if (bps === null) {
      ctx.addIssue({ code: "custom", message: "pourcentage attendu (ex. 1,5)" });
      return z.NEVER;
    }
    return bps;
  });
const parisInstant = z.string().transform((value, ctx) => {
  const iso = parisLocalToIso(value);
  if (iso === null) {
    ctx.addIssue({ code: "custom", message: "date et heure invalides (heure de Paris)" });
    return z.NEVER;
  }
  return iso;
});
const yesNo = z.enum(["yes", "no"]).transform((value) => value === "yes");
const uuidOrEmpty = optional(z.uuid("élément invalide"));

/** Montant saisi dans la devise indiquée → unités mineures, avec erreur rattachée au champ. */
function minorOf(ctx: z.RefinementCtx, field: string, value: string, code: string, allowZero: boolean): string {
  const minor = amountToMinor(value, code, allowZero);
  if (minor === null) {
    ctx.addIssue({ code: "custom", path: [field], message: allowZero ? "montant invalide pour cette devise" : "montant positif invalide pour cette devise" });
    return "0";
  }
  return minor;
}

// -----------------------------------------------------------------------------
// Marges de change
// -----------------------------------------------------------------------------
const pricingRuleForm = z.strictObject({
  sourceCurrency: optional(currency),
  destinationCurrency: optional(currency),
  margin: percent.pipe(z.number().max(1500, "15 % au maximum")),
  priority: integer(-1000, 1000),
  validFrom: optional(parisInstant),
  validTo: optional(parisInstant),
  replacesRuleId: uuidOrEmpty,
  justification,
});

export async function requestPricingRuleAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    pricingRuleForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: "/v1/admin/configuration/pricing-rule-requests",
        body: {
          sourceCurrency: input.sourceCurrency,
          destinationCurrency: input.destinationCurrency,
          marginBps: input.margin,
          priority: input.priority,
          validFrom: input.validFrom,
          validTo: input.validTo,
          replacesRuleId: input.replacesRuleId,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

const closureForm = z.strictObject({ id: z.uuid("choisissez un élément"), validTo: optional(parisInstant), justification });

export async function requestPricingClosureAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    closureForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/pricing-rules/${input.id}/closure-requests`,
        body: { validTo: input.validTo, justification: input.justification },
      }),
    () => ({ message: SENT }),
  );
}

// -----------------------------------------------------------------------------
// Barèmes de frais (montants dans la devise d'envoi)
// -----------------------------------------------------------------------------
const feeScheduleForm = z
  .strictObject({
    sourceCountry: optional(country),
    destinationCountry: optional(country),
    sourceCurrency: currency,
    destinationCurrency: optional(currency),
    payoutMethod: optional(z.enum(PAYOUT_METHODS)),
    fundingMethod: optional(z.enum(FUNDING_METHODS)),
    fixedFee: z.string(),
    percentage: percent.pipe(z.number().max(1000, "10 % au maximum")),
    minFee: z.string(),
    maxFee: z.string(),
    priority: integer(-1000, 1000),
    validFrom: optional(parisInstant),
    validTo: optional(parisInstant),
    replacesScheduleId: uuidOrEmpty,
    justification,
  })
  .transform((input, ctx) => ({
    ...input,
    fixedFee: minorOf(ctx, "fixedFee", input.fixedFee, input.sourceCurrency, true),
    minFee: minorOf(ctx, "minFee", input.minFee, input.sourceCurrency, true),
    maxFee: input.maxFee.trim() === "" ? null : minorOf(ctx, "maxFee", input.maxFee, input.sourceCurrency, true),
  }));

export async function requestFeeScheduleAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    feeScheduleForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: "/v1/admin/configuration/fee-schedule-requests",
        body: {
          sourceCountry: input.sourceCountry,
          destinationCountry: input.destinationCountry,
          sourceCurrency: input.sourceCurrency,
          destinationCurrency: input.destinationCurrency,
          payoutMethod: input.payoutMethod,
          fundingMethod: input.fundingMethod,
          fixedFee: input.fixedFee,
          percentageBps: input.percentage,
          minFee: input.minFee,
          maxFee: input.maxFee,
          priority: input.priority,
          validFrom: input.validFrom,
          validTo: input.validTo,
          replacesScheduleId: input.replacesScheduleId,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

export async function requestFeeClosureAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    closureForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/fee-schedules/${input.id}/closure-requests`,
        body: { validTo: input.validTo, justification: input.justification },
      }),
    () => ({ message: SENT }),
  );
}

// -----------------------------------------------------------------------------
// Corridors de paiement sortant (montants dans la devise de destination)
// -----------------------------------------------------------------------------
const corridorParameters = {
  priority: integer(-1000, 1000),
  minAmount: z.string(),
  maxAmount: z.string(),
  costFixed: z.string(),
  cost: percent.pipe(z.number().max(1000, "10 % au maximum")),
  estimatedDeliveryMinutes: integer(0, 20160),
  isEnabled: yesNo,
  providerRouteCode: optional(z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, "code du payeur invalide")),
  justification,
};

function corridorAmounts(input: { readonly minAmount: string; readonly maxAmount: string; readonly costFixed: string }, code: string, ctx: z.RefinementCtx) {
  return {
    minAmount: minorOf(ctx, "minAmount", input.minAmount, code, false),
    maxAmount: minorOf(ctx, "maxAmount", input.maxAmount, code, false),
    costFixed: minorOf(ctx, "costFixed", input.costFixed, code, true),
  };
}

const corridorForm = z
  .strictObject({
    sourceCountry: optional(country),
    destinationCountry: country,
    destinationCurrency: currency,
    payoutMethod: z.enum(PAYOUT_METHODS),
    provider: z.enum(PROVIDERS),
    ...corridorParameters,
  })
  .transform((input, ctx) => ({ ...input, ...corridorAmounts(input, input.destinationCurrency, ctx) }));

export async function requestCorridorAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    corridorForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: "/v1/admin/configuration/payout-corridor-requests",
        body: {
          sourceCountry: input.sourceCountry,
          destinationCountry: input.destinationCountry,
          destinationCurrency: input.destinationCurrency,
          payoutMethod: input.payoutMethod,
          provider: input.provider,
          priority: input.priority,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount,
          costFixed: input.costFixed,
          costBps: input.cost,
          estimatedDeliveryMinutes: input.estimatedDeliveryMinutes,
          isEnabled: input.isEnabled,
          providerRouteCode: input.providerRouteCode,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

export async function requestCorridorChangeAction(id: string, destinationCurrency: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id) || !/^[A-Z]{3}$/.test(destinationCurrency)) return invalidTarget();
  return mutation(
    form,
    z.strictObject(corridorParameters).transform((input, ctx) => ({ ...input, ...corridorAmounts(input, destinationCurrency, ctx) })),
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/payout-corridors/${id}/change-requests`,
        body: {
          priority: input.priority,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount,
          costFixed: input.costFixed,
          costBps: input.cost,
          estimatedDeliveryMinutes: input.estimatedDeliveryMinutes,
          isEnabled: input.isEnabled,
          providerRouteCode: input.providerRouteCode,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

// -----------------------------------------------------------------------------
// Moyens d'encaissement (montants dans la devise d'encaissement)
// -----------------------------------------------------------------------------
const payinParameters = {
  priority: integer(-1000, 1000),
  minAmount: z.string(),
  maxAmount: z.string(),
  costFixed: z.string(),
  cost: percent.pipe(z.number().max(1000, "10 % au maximum")),
  isEnabled: yesNo,
  justification,
};

const payinForm = z
  .strictObject({ country, currency, fundingMethod: z.enum(PAYIN_FUNDING_METHODS), provider: z.enum(PROVIDERS), ...payinParameters })
  .transform((input, ctx) => ({ ...input, ...corridorAmounts(input, input.currency, ctx) }));

export async function requestPayinAction(_previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  return mutation(
    form,
    payinForm,
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: "/v1/admin/configuration/payin-method-requests",
        body: {
          country: input.country,
          currency: input.currency,
          fundingMethod: input.fundingMethod,
          provider: input.provider,
          priority: input.priority,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount,
          costFixed: input.costFixed,
          costBps: input.cost,
          isEnabled: input.isEnabled,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

export async function requestPayinChangeAction(id: string, currencyCode: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!validId(id) || !/^[A-Z]{3}$/.test(currencyCode)) return invalidTarget();
  return mutation(
    form,
    z.strictObject(payinParameters).transform((input, ctx) => ({ ...input, ...corridorAmounts(input, currencyCode, ctx) })),
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/payin-methods/${id}/change-requests`,
        body: {
          priority: input.priority,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount,
          costFixed: input.costFixed,
          costBps: input.cost,
          isEnabled: input.isEnabled,
          justification: input.justification,
        },
      }),
    () => ({ message: SENT }),
  );
}

// -----------------------------------------------------------------------------
// Prestataires et pays
// -----------------------------------------------------------------------------
export async function requestProviderAction(code: string, isEnabled: boolean, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!(PROVIDERS as readonly string[]).includes(code)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ justification }),
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/providers/${code}/change-requests`,
        body: { isEnabled, justification: input.justification },
      }),
    () => ({ message: SENT }),
  );
}

export async function requestCountryAction(code: string, _previous: AdminActionState, form: FormData): Promise<AdminActionState> {
  if (!/^[A-Z]{2}$/.test(code)) return invalidTarget();
  return mutation(
    form,
    z.strictObject({ canSend: yesNo, canReceive: yesNo, riskLevel: z.enum(RISK_LEVELS), justification }),
    (input) =>
      actionApi<Approval>({
        method: "POST",
        path: `/v1/admin/configuration/countries/${code}/change-requests`,
        body: { canSend: input.canSend, canReceive: input.canReceive, riskLevel: input.riskLevel, justification: input.justification },
      }),
    () => ({ message: SENT }),
  );
}
