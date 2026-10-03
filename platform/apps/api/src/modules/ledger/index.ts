import type { Router } from "express";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { PermissionChecker } from "../../auth/permissions.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { DatabasePool } from "../../db/pool.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import { ledgerRoutes } from "./ledger.routes.js";
import { LedgerService } from "./ledger.service.js";
import { WalletService } from "./wallet.service.js";

export interface LedgerModule {
  readonly router: Router;
  readonly ledger: LedgerService;
  readonly wallets: WalletService;
}

export function createLedgerModule(params: {
  readonly pool: DatabasePool;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly permissions: PermissionChecker;
  readonly deviceBinding: DeviceBindingService;
}): LedgerModule {
  const ledger = new LedgerService();
  const wallets = new WalletService(params.pool, ledger);
  return { router: ledgerRoutes({ ...params, wallets }), ledger, wallets };
}
