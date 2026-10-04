import type { Router } from "express";
import type { Logger } from "pino";
import type { RateLimiterAbstract } from "rate-limiter-flexible";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { createPwnedPasswordsChecker, PasswordService } from "../auth/password.service.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import type { PaymentOrchestrator } from "../transfers/payment.orchestrator.js";
import { AdminAuthService } from "./adminAuth.service.js";
import { createApprovalRegistry } from "./approvalActions.js";
import { ApprovalService } from "./approvals.service.js";
import { backofficeRoutes } from "./backoffice.routes.js";
import { ComplianceAdminService } from "./compliance.admin.js";
import { CustomersAdminService } from "./customers.admin.js";
import { StaffAdminService } from "./staff.admin.js";
import { TransfersAdminService } from "./transfers.admin.js";

/**
 * Assemblage du back-office : authentification du personnel, opérations de
 * conformité et double validation. À monter AVANT les autres modules : sa
 * garde de préfixe protège toutes les routes /v1/admin/*.
 */

export interface BackofficeModule {
  readonly router: Router;
  readonly auth: AdminAuthService;
  readonly approvals: ApprovalService;
}

export function createBackofficeModule(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly encryptor: FieldEncryptor;
  readonly indexer: BlindIndexer;
  readonly ledger: LedgerService;
  readonly orchestrator: PaymentOrchestrator;
  readonly limiters: { readonly loginByIp: RateLimiterAbstract; readonly loginByEmail: RateLimiterAbstract };
  readonly breachChecker?: ((password: string) => Promise<boolean>) | null;
}): BackofficeModule {
  const { config, pool, logger } = params;
  const breachChecker =
    params.breachChecker === undefined
      ? config.auth.passwordBreachCheck
        ? createPwnedPasswordsChecker(fetch, (error) => {
            logger.warn({ err: error }, "contrôle de fuite des mots de passe indisponible");
          })
        : undefined
      : (params.breachChecker ?? undefined);
  const auth = new AdminAuthService({ pool, passwords: new PasswordService(breachChecker), logger, issuer: config.jwt.issuer, admin: config.admin });
  const approvals = new ApprovalService(pool, createApprovalRegistry({ admin: config.admin, ledger: params.ledger, orchestrator: params.orchestrator }), logger);
  const router = backofficeRoutes({
    pool,
    verifier: params.verifier,
    sessions: params.sessions,
    auth,
    approvals,
    customers: new CustomersAdminService({ pool, encryptor: params.encryptor, indexer: params.indexer }),
    transfers: new TransfersAdminService({ pool, orchestrator: params.orchestrator }),
    compliance: new ComplianceAdminService({ pool, encryptor: params.encryptor, verificationValidityDays: config.kyc.verificationValidityDays }),
    staff: new StaffAdminService({ pool, admin: config.admin }),
    limiters: params.limiters,
  });
  return { router, auth, approvals };
}
