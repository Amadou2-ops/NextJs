import type { DatabasePool } from "../db/pool.js";

/**
 * Permissions du personnel. La matrice rôles → permissions est versionnée en
 * base (db/migrations/0015) et lue à chaque requête : un retrait de rôle prend
 * effet immédiatement.
 */

export const ADMIN_PERMISSIONS = [
  "customers:read",
  "customers:read_pii",
  "customers:suspend",
  "transfers:read",
  "transfers:hold",
  "transfers:release",
  "transfers:refund",
  "kyc:read",
  "kyc:decide",
  "aml:alerts:read",
  "aml:alerts:manage",
  "aml:cases:manage",
  "aml:sar:file",
  "ledger:read",
  "ledger:freeze",
  "ledger:adjust",
  "routing:manage",
  "pricing:manage",
  "countries:manage",
  "admins:manage",
  "audit:read",
  "approvals:decide",
  "configuration:read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export interface PermissionChecker {
  hasPermission(adminUserId: string, permission: AdminPermission): Promise<boolean>;
}

export class PostgresPermissionChecker implements PermissionChecker {
  constructor(private readonly pool: DatabasePool) {}

  async hasPermission(adminUserId: string, permission: AdminPermission): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      "SELECT backoffice.has_permission($1, $2) AS allowed",
      [adminUserId, permission],
    );
    return result.rows[0]?.allowed === true;
  }
}
