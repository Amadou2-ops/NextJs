import { z } from "zod";

import {
  accountStatusPayloadSchema,
  adminNetworkPayloadSchema,
  fileSarPayloadSchema,
  grantRolesPayloadSchema,
  inviteAdminPayloadSchema,
  ledgerAdjustmentPayloadSchema,
  refundTransferPayloadSchema,
  reverseJournalPayloadSchema,
  STAFF_ROLES,
} from "./approvalActions.js";
import {
  closeRulePayloadSchema,
  corridorChangePayloadSchema,
  corridorCreatePayloadSchema,
  countryPayloadSchema,
  feeSchedulePayloadSchema,
  FUNDING_METHODS,
  PAYMENT_PROVIDERS,
  payinChangePayloadSchema,
  payinCreatePayloadSchema,
  PAYOUT_METHODS,
  pricingRulePayloadSchema,
  providerPayloadSchema,
} from "./configurationActions.js";

/** Schémas stricts des routes du back-office (propriétés inconnues refusées). */

const justification = z.string().trim().min(10).max(1000);
const note = z.string().trim().min(10).max(2000);
const limit = z.coerce.number().int().min(1).max(200).default(50);

export const idParamsSchema = z.strictObject({ id: z.uuid() });
export const roleParamsSchema = z.strictObject({ id: z.uuid(), role: z.enum(STAFF_ROLES) });

// Authentification -----------------------------------------------------------
export const enrollmentOptionsSchema = z.strictObject({ invitationToken: z.string().min(10).max(100) });
export const enrollmentCompleteSchema = z.strictObject({
  invitationToken: z.string().min(10).max(100),
  challengeId: z.uuid(),
  password: z.string().min(1).max(128),
  nickname: z.string().trim().min(1).max(60).optional(),
  // Réponse WebAuthn du navigateur, validée par @simplewebauthn/server.
  response: z.looseObject({ id: z.string().min(1).max(1024), rawId: z.string().min(1).max(1024), type: z.literal("public-key"), response: z.looseObject({}) }),
});
export const loginSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) });
export const loginVerifySchema = z.strictObject({
  challengeId: z.uuid(),
  response: z.looseObject({ id: z.string().min(1).max(1024), rawId: z.string().min(1).max(1024), type: z.literal("public-key"), response: z.looseObject({}) }),
});
export const refreshSchema = z.strictObject({ refreshToken: z.string().min(10).max(100) });

// Clients --------------------------------------------------------------------
export const customerSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(254).optional(),
  status: z.enum(["pending_verification", "active", "suspended", "closed"]).optional(),
  limit,
});
export const justificationSchema = z.strictObject({ justification });
export const customerStatusSchema = z.strictObject({ status: z.enum(["suspended", "active"]), reason: justification });

// Transferts -----------------------------------------------------------------
export const transferListQuerySchema = z.strictObject({
  status: z
    .enum(["created", "awaiting_funding", "funding_processing", "funded", "compliance_review", "payout_pending", "payout_processing", "payout_failed", "completed", "refund_pending", "refunded", "cancelled"])
    .optional(),
  userId: z.uuid().optional(),
  reference: z.string().regex(/^TP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit,
});
export const reasonSchema = z.strictObject({ reason: justification });
export const noteSchema = z.strictObject({ note });
export const refundRequestSchema = z.strictObject({ reason: refundTransferPayloadSchema.shape.reason, justification });

// KYC ------------------------------------------------------------------------
export const kycQueueQuerySchema = z.strictObject({ limit });
export const kycDetailQuerySchema = z.strictObject({ reveal: z.enum(["identity"]).optional() });
export const kycDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject", "resubmission_required"]),
  reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).max(10).default([]),
  note,
});

// AML ------------------------------------------------------------------------
export const alertListQuerySchema = z.strictObject({
  status: z.enum(["open", "under_review", "escalated", "closed_false_positive", "closed_confirmed"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  limit,
});
export const alertResolutionSchema = z.strictObject({ outcome: z.enum(["false_positive", "confirmed"]), note });
export const caseListQuerySchema = z.strictObject({ status: z.enum(["open", "investigating", "sar_filed", "closed"]).optional(), limit });
export const caseCreateSchema = z.strictObject({
  userId: z.uuid(),
  summary: z.string().trim().min(10).max(5000),
  alertIds: z.array(z.uuid()).max(100).default([]),
});
export const caseAlertsSchema = z.strictObject({ alertIds: z.array(z.uuid()).min(1).max(100) });
export const caseTransitionSchema = z.strictObject({ status: z.enum(["investigating", "closed"]), note });
export const sarRequestSchema = z.strictObject({ ...fileSarPayloadSchema.shape, justification });

// Registre -------------------------------------------------------------------
export const accountStatusRequestSchema = z.strictObject({ ...accountStatusPayloadSchema.shape, justification });
export const adjustmentRequestSchema = z.strictObject({ ...ledgerAdjustmentPayloadSchema.shape, justification });
export const reversalRequestSchema = z.strictObject({ ...reverseJournalPayloadSchema.shape, justification });

// Approbations ---------------------------------------------------------------
export const approvalListQuerySchema = z.strictObject({ status: z.enum(["pending", "approved", "rejected", "expired", "executed"]).optional(), limit });
export const approveSchema = z.strictObject({ note: z.string().trim().min(1).max(2000).optional() });
export const rejectSchema = z.strictObject({ note });

// Personnel ------------------------------------------------------------------
export const staffListQuerySchema = z.strictObject({ status: z.enum(["invited", "active", "suspended", "disabled"]).optional() });
export const invitationRequestSchema = z.strictObject({ ...inviteAdminPayloadSchema.shape, justification });
export const roleRequestSchema = z.strictObject({ ...grantRolesPayloadSchema.shape, justification });
export const networkRequestSchema = z.strictObject({ ...adminNetworkPayloadSchema.shape, justification });
export const staffRestrictionSchema = z.strictObject({ status: z.enum(["suspended", "disabled"]), reason: justification });

// Audit ----------------------------------------------------------------------
export const auditQuerySchema = z.strictObject({
  actorId: z.string().max(200).optional(),
  targetType: z.string().regex(/^[a-z_]{2,50}$/).optional(),
  targetId: z.string().max(200).optional(),
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/).optional(),
  before: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
  limit,
});

// Paramétrage ----------------------------------------------------------------
// Champs facultatifs de la requête = null explicite dans la demande (la base
// compare chaque clé du contenu approuvé à la ligne écrite).
const pricing = pricingRulePayloadSchema.shape;
const fees = feeSchedulePayloadSchema.shape;
const corridor = corridorCreatePayloadSchema.shape;

export const ruleListQuerySchema = z.strictObject({ state: z.enum(["current", "all"]).default("current") });
export const countryListQuerySchema = z.strictObject({ filter: z.enum(["open", "all"]).default("open") });
export const providerParamsSchema = z.strictObject({ code: z.enum(PAYMENT_PROVIDERS) });
export const countryParamsSchema = z.strictObject({ code: z.string().regex(/^[A-Z]{2}$/) });

export const pricingRuleRequestSchema = z.strictObject({
  sourceCurrency: pricing.sourceCurrency.default(null),
  destinationCurrency: pricing.destinationCurrency.default(null),
  marginBps: pricing.marginBps,
  priority: pricing.priority.default(0),
  validFrom: pricing.validFrom.default(null),
  validTo: pricing.validTo.default(null),
  replacesRuleId: pricing.replacesRuleId.default(null),
  justification,
});
export const feeScheduleRequestSchema = z.strictObject({
  sourceCountry: fees.sourceCountry.default(null),
  destinationCountry: fees.destinationCountry.default(null),
  sourceCurrency: fees.sourceCurrency,
  destinationCurrency: fees.destinationCurrency.default(null),
  payoutMethod: fees.payoutMethod.default(null),
  fundingMethod: fees.fundingMethod.default(null),
  fixedFee: fees.fixedFee,
  percentageBps: fees.percentageBps,
  minFee: fees.minFee,
  maxFee: fees.maxFee.default(null),
  priority: fees.priority.default(0),
  validFrom: fees.validFrom.default(null),
  validTo: fees.validTo.default(null),
  replacesScheduleId: fees.replacesScheduleId.default(null),
  justification,
});
export const closureRequestSchema = z.strictObject({ validTo: closeRulePayloadSchema.shape.validTo.default(null), justification });
export const corridorRequestSchema = z.strictObject({
  ...corridor,
  sourceCountry: corridor.sourceCountry.default(null),
  providerRouteCode: corridor.providerRouteCode.default(null),
  justification,
});
export const corridorChangeRequestSchema = z.strictObject({
  ...corridorChangePayloadSchema.shape,
  providerRouteCode: corridorChangePayloadSchema.shape.providerRouteCode.default(null),
  justification,
});
export const payinRequestSchema = z.strictObject({ ...payinCreatePayloadSchema.shape, justification });
export const payinChangeRequestSchema = z.strictObject({ ...payinChangePayloadSchema.shape, justification });
export const providerRequestSchema = z.strictObject({ ...providerPayloadSchema.shape, justification });
export const countryRequestSchema = z.strictObject({ ...countryPayloadSchema.shape, justification });
export const quotePreviewSchema = z.strictObject({
  sourceCountry: z.string().regex(/^[A-Z]{2}$/),
  destinationCountry: z.string().regex(/^[A-Z]{2}$/),
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  destinationCurrency: z.string().regex(/^[A-Z]{3}$/),
  payoutMethod: z.enum(PAYOUT_METHODS),
  fundingMethod: z.enum(FUNDING_METHODS),
  amount: z
    .string()
    .regex(/^[1-9][0-9]{0,14}$/)
    .transform((value) => BigInt(value)),
  amountType: z.enum(["send", "receive"]).default("send"),
});
