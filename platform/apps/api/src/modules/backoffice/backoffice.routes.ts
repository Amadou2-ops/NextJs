import { randomUUID } from "node:crypto";

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import { ForbiddenError } from "../../lib/errors.js";
import { byClientIp, rateLimit } from "../../middlewares/rateLimit.js";
import type { RateLimitKey } from "../../middlewares/rateLimit.js";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middlewares/validate.js";
import { adminAccess, adminContextOf, adminPrefixGuard, clientIpOf } from "./access.js";
import type { AdminAccessDependencies } from "./access.js";
import type { AdminAuthService, AdminLoginContext, AdminTokens } from "./adminAuth.service.js";
import type { ApprovalService } from "./approvals.service.js";
import {
  accountStatusRequestSchema,
  adjustmentRequestSchema,
  alertListQuerySchema,
  alertResolutionSchema,
  approvalListQuerySchema,
  approveSchema,
  auditQuerySchema,
  caseAlertsSchema,
  caseCreateSchema,
  caseListQuerySchema,
  caseTransitionSchema,
  customerSearchQuerySchema,
  customerStatusSchema,
  enrollmentCompleteSchema,
  enrollmentOptionsSchema,
  idParamsSchema,
  invitationRequestSchema,
  justificationSchema,
  kycDecisionSchema,
  kycDetailQuerySchema,
  kycQueueQuerySchema,
  loginSchema,
  loginVerifySchema,
  networkRequestSchema,
  noteSchema,
  reasonSchema,
  refreshSchema,
  refundRequestSchema,
  rejectSchema,
  reversalRequestSchema,
  roleParamsSchema,
  roleRequestSchema,
  sarRequestSchema,
  staffListQuerySchema,
  staffRestrictionSchema,
  transferListQuerySchema,
} from "./backoffice.schemas.js";
import type { ComplianceAdminService } from "./compliance.admin.js";
import type { CustomersAdminService } from "./customers.admin.js";
import type { StaffAdminService } from "./staff.admin.js";
import type { TransfersAdminService } from "./transfers.admin.js";

/**
 * API du back-office (/v1/admin). Toutes les réponses sont « no-store ».
 *
 *   Authentification   /v1/admin/auth/*         invitation, connexion en deux temps, renouvellement
 *   Moi                /v1/admin/me             profil, rôles, permissions
 *   Clients            /v1/admin/customers      recherche exacte, fiche, PII tracées, suspension
 *   Transferts         /v1/admin/transfers      file, détail, mise en revue, libération, remboursement (4 yeux)
 *   KYC                /v1/admin/kyc            file de revue manuelle, décision
 *   AML                /v1/admin/aml            alertes, dossiers, déclaration de soupçon (4 yeux)
 *   Registre           /v1/admin/ledger         gel, ajustement, contre-passation (4 yeux)
 *   Approbations       /v1/admin/approvals      file, approbation + exécution, refus
 *   Personnel          /v1/admin/staff          invitations, rôles, réseau (4 yeux), suspension
 *   Audit              /v1/admin/audit          journal chaîné, vérification d'intégrité
 */

export interface BackofficeRouterDependencies extends AdminAccessDependencies {
  readonly auth: AdminAuthService;
  readonly approvals: ApprovalService;
  readonly customers: CustomersAdminService;
  readonly transfers: TransfersAdminService;
  readonly compliance: ComplianceAdminService;
  readonly staff: StaffAdminService;
  readonly limiters: { readonly loginByIp: RateLimiterAbstract; readonly loginByEmail: RateLimiterAbstract };
}

function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    handler(req, res).catch(next);
  };
}

const byEmailInBody: RateLimitKey = (req) => {
  const body = req.body as { email?: unknown } | undefined;
  return typeof body?.email === "string" ? `admin-email:${body.email.trim().toLowerCase().slice(0, 254)}` : byClientIp(req);
};

function loginContextOf(req: Request): AdminLoginContext {
  return { ipAddress: clientIpOf(req), userAgent: req.get("user-agent"), requestId: req.requestId };
}

function presentTokens(tokens: AdminTokens): Record<string, unknown> {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    sessionExpiresAt: tokens.sessionExpiresAt.toISOString(),
  };
}

export function backofficeRoutes(deps: BackofficeRouterDependencies): Router {
  const router = Router();
  const can = adminAccess(deps);
  const loginByIp = rateLimit(deps.limiters.loginByIp, byClientIp);
  const loginByEmail = rateLimit(deps.limiters.loginByEmail, byEmailInBody);

  router.use(adminPrefixGuard(deps));

  // ---------------------------------------------------------------------------
  // Authentification
  // ---------------------------------------------------------------------------
  router.post(
    "/v1/admin/auth/enrollment/options",
    loginByIp,
    validate({ body: enrollmentOptionsSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, enrollmentOptionsSchema);
      res.json(await deps.auth.enrollmentOptions(body.invitationToken, loginContextOf(req)));
    }),
  );
  router.post(
    "/v1/admin/auth/enrollment/complete",
    loginByIp,
    validate({ body: enrollmentCompleteSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, enrollmentCompleteSchema);
      const result = await deps.auth.completeEnrollment(
        {
          invitationToken: body.invitationToken,
          challengeId: body.challengeId,
          password: body.password,
          response: body.response as unknown as RegistrationResponseJSON,
          nickname: body.nickname,
        },
        loginContextOf(req),
      );
      res.status(201).json({ adminId: result.adminId, status: "active" });
    }),
  );
  router.post(
    "/v1/admin/auth/login",
    loginByIp,
    loginByEmail,
    validate({ body: loginSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, loginSchema);
      res.json(await deps.auth.startLogin(body.email, body.password, loginContextOf(req)));
    }),
  );
  router.post(
    "/v1/admin/auth/login/verify",
    loginByIp,
    validate({ body: loginVerifySchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, loginVerifySchema);
      const tokens = await deps.auth.completeLogin({ challengeId: body.challengeId, response: body.response as unknown as AuthenticationResponseJSON }, loginContextOf(req));
      res.json(presentTokens(tokens));
    }),
  );
  router.post(
    "/v1/admin/auth/token/refresh",
    loginByIp,
    validate({ body: refreshSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, refreshSchema);
      res.json(presentTokens(await deps.auth.refresh(body.refreshToken, loginContextOf(req))));
    }),
  );
  router.post(
    "/v1/admin/auth/logout",
    ...can(null),
    handle(async (req, res) => {
      const context = adminContextOf(req);
      await deps.auth.logout(context.adminId, context.sessionId, context);
      res.status(204).end();
    }),
  );

  router.get(
    "/v1/admin/me",
    ...can(null),
    handle(async (req, res) => {
      res.json(await deps.staff.me(adminContextOf(req).adminId));
    }),
  );

  // ---------------------------------------------------------------------------
  // Clients
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/customers",
    ...can("customers:read"),
    validate({ query: customerSearchQuerySchema }),
    handle(async (req, res) => {
      const query = validatedQuery(req, customerSearchQuerySchema);
      res.json({ items: await deps.customers.search({ query: query.q, status: query.status, limit: query.limit }) });
    }),
  );
  router.get(
    "/v1/admin/customers/:id",
    ...can("customers:read"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.customers.detail(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/customers/:id/pii",
    ...can("customers:read_pii"),
    validate({ params: idParamsSchema, body: justificationSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.customers.revealPii(adminContextOf(req), id, validatedBody(req, justificationSchema).justification));
    }),
  );
  router.post(
    "/v1/admin/customers/:id/status",
    ...can("customers:suspend"),
    validate({ params: idParamsSchema, body: customerStatusSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, customerStatusSchema);
      res.json(await deps.customers.setStatus(adminContextOf(req), id, body.status, body.reason));
    }),
  );

  // ---------------------------------------------------------------------------
  // Transferts
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/transfers",
    ...can("transfers:read"),
    validate({ query: transferListQuerySchema }),
    handle(async (req, res) => {
      res.json(await deps.transfers.list(validatedQuery(req, transferListQuerySchema)));
    }),
  );
  router.get(
    "/v1/admin/transfers/:id",
    ...can("transfers:read"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.transfers.detail(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/transfers/:id/hold",
    ...can("transfers:hold"),
    validate({ params: idParamsSchema, body: reasonSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.transfers.hold(adminContextOf(req), id, validatedBody(req, reasonSchema).reason));
    }),
  );
  router.post(
    "/v1/admin/transfers/:id/release",
    ...can("transfers:release"),
    validate({ params: idParamsSchema, body: noteSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.transfers.release(adminContextOf(req), id, validatedBody(req, noteSchema).note));
    }),
  );
  router.post(
    "/v1/admin/transfers/:id/refund-requests",
    ...can("transfers:refund"),
    validate({ params: idParamsSchema, body: refundRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, refundRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "refund_transfer", targetId: id, payload: { reason: body.reason }, justification: body.justification }));
    }),
  );

  // ---------------------------------------------------------------------------
  // KYC
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/kyc/reviews",
    ...can("kyc:read"),
    validate({ query: kycQueueQuerySchema }),
    handle(async (req, res) => {
      res.json({ items: await deps.compliance.kycQueue(validatedQuery(req, kycQueueQuerySchema).limit) });
    }),
  );
  router.get(
    "/v1/admin/kyc/verifications/:id",
    ...can("kyc:read"),
    validate({ params: idParamsSchema, query: kycDetailQuerySchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const revealRequested = validatedQuery(req, kycDetailQuerySchema).reveal === "identity";
      if (revealRequested && !(await canRevealPii(deps, req))) {
        throw new ForbiddenError("Vous ne disposez pas de l'habilitation requise.", { reason: "permission_denied", permission: "customers:read_pii" });
      }
      res.json(await deps.compliance.kycDetail(adminContextOf(req), id, revealRequested));
    }),
  );
  router.post(
    "/v1/admin/kyc/verifications/:id/decision",
    ...can("kyc:decide"),
    validate({ params: idParamsSchema, body: kycDecisionSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.compliance.decideKyc(adminContextOf(req), id, validatedBody(req, kycDecisionSchema)));
    }),
  );

  // ---------------------------------------------------------------------------
  // AML
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/aml/alerts",
    ...can("aml:alerts:read"),
    validate({ query: alertListQuerySchema }),
    handle(async (req, res) => {
      const query = validatedQuery(req, alertListQuerySchema);
      res.json({ items: await deps.compliance.alerts({ status: query.status, severity: query.severity, assignedToMe: query.mine === "true", adminId: adminContextOf(req).adminId, limit: query.limit }) });
    }),
  );
  router.get(
    "/v1/admin/aml/alerts/:id",
    ...can("aml:alerts:read"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.compliance.alertDetail(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/aml/alerts/:id/assign",
    ...can("aml:alerts:manage"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.compliance.assignAlert(adminContextOf(req), validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/aml/alerts/:id/escalate",
    ...can("aml:alerts:manage"),
    validate({ params: idParamsSchema, body: noteSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.compliance.escalateAlert(adminContextOf(req), id, validatedBody(req, noteSchema).note));
    }),
  );
  router.post(
    "/v1/admin/aml/alerts/:id/resolve",
    ...can("aml:alerts:manage"),
    validate({ params: idParamsSchema, body: alertResolutionSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.compliance.resolveAlert(adminContextOf(req), id, validatedBody(req, alertResolutionSchema)));
    }),
  );
  router.get(
    "/v1/admin/aml/cases",
    ...can("aml:alerts:read"),
    validate({ query: caseListQuerySchema }),
    handle(async (req, res) => {
      res.json({ items: await deps.compliance.cases(validatedQuery(req, caseListQuerySchema)) });
    }),
  );
  router.post(
    "/v1/admin/aml/cases",
    ...can("aml:cases:manage"),
    validate({ body: caseCreateSchema }),
    handle(async (req, res) => {
      res.status(201).json(await deps.compliance.openCase(adminContextOf(req), validatedBody(req, caseCreateSchema)));
    }),
  );
  router.get(
    "/v1/admin/aml/cases/:id",
    ...can("aml:alerts:read"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.compliance.caseDetail(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/aml/cases/:id/alerts",
    ...can("aml:cases:manage"),
    validate({ params: idParamsSchema, body: caseAlertsSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.compliance.linkAlerts(adminContextOf(req), id, validatedBody(req, caseAlertsSchema).alertIds));
    }),
  );
  router.post(
    "/v1/admin/aml/cases/:id/status",
    ...can("aml:cases:manage"),
    validate({ params: idParamsSchema, body: caseTransitionSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, caseTransitionSchema);
      res.json(await deps.compliance.transitionCase(adminContextOf(req), id, body.status, body.note));
    }),
  );
  router.post(
    "/v1/admin/aml/cases/:id/sar-requests",
    ...can("aml:sar:file"),
    validate({ params: idParamsSchema, body: sarRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, sarRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "file_sar", targetId: id, payload: { sarReference: body.sarReference }, justification: body.justification }));
    }),
  );

  // ---------------------------------------------------------------------------
  // Registre (actions en double validation ; la consultation est dans le module ledger)
  // ---------------------------------------------------------------------------
  router.post(
    "/v1/admin/ledger/accounts/:id/status-requests",
    ...can("ledger:freeze"),
    validate({ params: idParamsSchema, body: accountStatusRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, accountStatusRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "set_account_status", targetId: id, payload: { status: body.status, reason: body.reason }, justification: body.justification }));
    }),
  );
  router.post(
    "/v1/admin/ledger/adjustment-requests",
    ...can("ledger:adjust"),
    validate({ body: adjustmentRequestSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, adjustmentRequestSchema);
      res.status(202).json(
        await deps.approvals.request(adminContextOf(req), {
          actionType: "ledger_adjustment",
          targetId: `admin-adjustment:${randomUUID()}`,
          payload: { description: body.description, entries: body.entries },
          justification: body.justification,
        }),
      );
    }),
  );
  router.post(
    "/v1/admin/ledger/journals/:id/reversal-requests",
    ...can("ledger:adjust"),
    validate({ params: idParamsSchema, body: reversalRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, reversalRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "reverse_journal", targetId: id, payload: { reason: body.reason }, justification: body.justification }));
    }),
  );

  // ---------------------------------------------------------------------------
  // Approbations : l'approbateur doit détenir approvals:decide ET la
  // permission de l'action (vérifié par la base).
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/approvals",
    ...can("approvals:decide"),
    validate({ query: approvalListQuerySchema }),
    handle(async (req, res) => {
      res.json({ items: await deps.approvals.list(validatedQuery(req, approvalListQuerySchema)) });
    }),
  );
  router.get(
    "/v1/admin/approvals/:id",
    ...can("approvals:decide"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.approvals.get(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/approvals/:id/approve",
    ...can("approvals:decide"),
    validate({ params: idParamsSchema, body: approveSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.approvals.approve(adminContextOf(req), id, validatedBody(req, approveSchema).note));
    }),
  );
  router.post(
    "/v1/admin/approvals/:id/reject",
    ...can("approvals:decide"),
    validate({ params: idParamsSchema, body: rejectSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.json(await deps.approvals.reject(adminContextOf(req), id, validatedBody(req, rejectSchema).note));
    }),
  );

  // ---------------------------------------------------------------------------
  // Personnel et audit
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/admin/staff",
    ...can("admins:manage"),
    validate({ query: staffListQuerySchema }),
    handle(async (req, res) => {
      res.json({ items: await deps.staff.list(validatedQuery(req, staffListQuerySchema)) });
    }),
  );
  router.post(
    "/v1/admin/staff/invitations",
    ...can("admins:manage"),
    validate({ body: invitationRequestSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, invitationRequestSchema);
      const email = body.email.toLowerCase();
      res.status(202).json(
        await deps.approvals.request(adminContextOf(req), {
          actionType: "invite_admin",
          targetId: email,
          payload: { email, fullName: body.fullName, roles: body.roles, allowedIpRanges: body.allowedIpRanges },
          justification: body.justification,
        }),
      );
    }),
  );
  router.get(
    "/v1/admin/staff/:id",
    ...can("admins:manage"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.staff.get(validatedParams(req, idParamsSchema).id));
    }),
  );
  router.post(
    "/v1/admin/staff/:id/role-requests",
    ...can("admins:manage"),
    validate({ params: idParamsSchema, body: roleRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, roleRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "grant_roles", targetId: id, payload: { roles: body.roles }, justification: body.justification }));
    }),
  );
  router.post(
    "/v1/admin/staff/:id/network-requests",
    ...can("admins:manage"),
    validate({ params: idParamsSchema, body: networkRequestSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, networkRequestSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "update_admin_network", targetId: id, payload: { allowedIpRanges: body.allowedIpRanges }, justification: body.justification }));
    }),
  );
  router.post(
    "/v1/admin/staff/:id/reactivation-requests",
    ...can("admins:manage"),
    validate({ params: idParamsSchema, body: justificationSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      res.status(202).json(await deps.approvals.request(adminContextOf(req), { actionType: "reactivate_admin", targetId: id, payload: {}, justification: validatedBody(req, justificationSchema).justification }));
    }),
  );
  router.post(
    "/v1/admin/staff/:id/restriction",
    ...can("admins:manage"),
    validate({ params: idParamsSchema, body: staffRestrictionSchema }),
    handle(async (req, res) => {
      const { id } = validatedParams(req, idParamsSchema);
      const body = validatedBody(req, staffRestrictionSchema);
      res.json(await deps.staff.restrict(adminContextOf(req), id, body.status, body.reason));
    }),
  );
  router.delete(
    "/v1/admin/staff/:id/roles/:role",
    ...can("admins:manage"),
    validate({ params: roleParamsSchema, body: reasonSchema }),
    handle(async (req, res) => {
      const { id, role } = validatedParams(req, roleParamsSchema);
      res.json(await deps.staff.revokeRole(adminContextOf(req), id, role, validatedBody(req, reasonSchema).reason));
    }),
  );
  router.post(
    "/v1/admin/staff/:id/invitation",
    ...can("admins:manage"),
    validate({ params: idParamsSchema }),
    handle(async (req, res) => {
      res.json(await deps.staff.renewInvitation(adminContextOf(req), validatedParams(req, idParamsSchema).id));
    }),
  );

  router.get(
    "/v1/admin/audit/events",
    ...can("audit:read"),
    validate({ query: auditQuerySchema }),
    handle(async (req, res) => {
      const query = validatedQuery(req, auditQuerySchema);
      res.json(await deps.staff.auditEvents({ actorId: query.actorId, targetType: query.targetType, targetId: query.targetId, action: query.action, beforeId: query.before, limit: query.limit }));
    }),
  );
  router.get(
    "/v1/admin/audit/integrity",
    ...can("audit:read"),
    handle(async (_req, res) => {
      res.json(await deps.staff.auditIntegrity());
    }),
  );

  return router;
}

/** Le déchiffrement de la pièce d'identité exige en plus customers:read_pii. */
async function canRevealPii(deps: BackofficeRouterDependencies, req: Request): Promise<boolean> {
  const result = await deps.pool.query<{ allowed: boolean }>("SELECT backoffice.has_permission($1, 'customers:read_pii') AS allowed", [adminContextOf(req).adminId]);
  return result.rows[0]?.allowed === true;
}
