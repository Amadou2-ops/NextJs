import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AccessTokenVerifier } from "../../auth/accessToken.js";
import type { PermissionChecker } from "../../auth/permissions.js";
import type { SessionValidator } from "../../auth/sessions.js";
import type { DatabasePool } from "../../db/pool.js";
import { AuthenticationError, NotFoundError } from "../../lib/errors.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireDeviceSignature } from "../../middlewares/requireDeviceSignature.js";
import { requirePermission } from "../../middlewares/requirePermission.js";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middlewares/validate.js";
import type { DeviceBindingService } from "../auth/deviceBinding.service.js";
import * as repository from "./ledger.repository.js";
import {
  accountIdParamsSchema,
  journalIdParamsSchema,
  openWalletSchema,
  statementQuerySchema,
  walletCurrencyParamsSchema,
} from "./ledger.schemas.js";
import type { WalletService } from "./wallet.service.js";

/**
 * Routes du registre :
 *   - /v1/wallets : portefeuilles du client authentifié (lecture, ouverture) ;
 *   - /v1/admin/ledger : consultation par le personnel habilité (ledger:read).
 * Aucune route ne permet d'écrire une écriture comptable arbitraire : les
 * mouvements naissent exclusivement des opérations métier (transferts,
 * encaissements, remboursements) et des ajustements en double validation.
 */

export interface LedgerRouterDependencies {
  readonly pool: DatabasePool;
  readonly wallets: WalletService;
  readonly verifier: AccessTokenVerifier;
  readonly sessions: SessionValidator;
  readonly permissions: PermissionChecker;
  readonly deviceBinding: DeviceBindingService;
}

function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

function subjectOf(req: Request): string {
  if (req.auth === undefined) throw new AuthenticationError();
  return req.auth.subjectId;
}

function hex(buffer: Buffer): string {
  return buffer.toString("hex");
}

export function ledgerRoutes(deps: LedgerRouterDependencies): Router {
  const router = Router();
  const customer = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["mobile", "web"]);
  const admin = authenticate({ verifier: deps.verifier, sessions: deps.sessions }, ["admin"]);
  const canRead = requirePermission(deps.permissions, "ledger:read");
  const deviceSigned = requireDeviceSignature(deps.deviceBinding);

  // --- Client --------------------------------------------------------------
  router.get(
    "/v1/wallets",
    customer,
    handle(async (req, res) => {
      res.json({ wallets: await deps.wallets.list(subjectOf(req)) });
    }),
  );

  router.post(
    "/v1/wallets",
    customer,
    deviceSigned,
    validate({ body: openWalletSchema }),
    handle(async (req, res) => {
      const body = validatedBody(req, openWalletSchema);
      res.status(201).json(await deps.wallets.open(subjectOf(req), body.currency));
    }),
  );

  router.get(
    "/v1/wallets/:currency/statement",
    customer,
    validate({ params: walletCurrencyParamsSchema, query: statementQuerySchema }),
    handle(async (req, res) => {
      const params = validatedParams(req, walletCurrencyParamsSchema);
      const query = validatedQuery(req, statementQuerySchema);
      res.json(await deps.wallets.statement(subjectOf(req), params.currency, { limit: query.limit, ...(query.before === undefined ? {} : { before: query.before }) }));
    }),
  );

  // --- Personnel -------------------------------------------------------------
  router.get(
    "/v1/admin/ledger/accounts/:accountId",
    admin,
    canRead,
    validate({ params: accountIdParamsSchema }),
    handle(async (req, res) => {
      const { accountId } = validatedParams(req, accountIdParamsSchema);
      const account = await repository.findAccount(deps.pool, accountId);
      if (account === undefined) throw new NotFoundError("Compte introuvable.");
      res.json({
        id: account.id,
        code: account.code,
        type: account.account_type,
        normalSide: account.normal_side,
        currency: account.currency,
        ownerUserId: account.owner_user_id,
        provider: account.provider,
        status: account.status,
        statusReason: account.status_reason,
        allowNegative: account.allow_negative,
        // Les comptes techniques peuvent être négatifs : montant signé en chaîne.
        balance: { amount: account.balance.toString(), currency: account.currency },
        entryCount: account.last_entry_seq.toString(),
        createdAt: account.created_at.toISOString(),
      });
    }),
  );

  router.get(
    "/v1/admin/ledger/accounts/:accountId/entries",
    admin,
    canRead,
    validate({ params: accountIdParamsSchema, query: statementQuerySchema }),
    handle(async (req, res) => {
      const { accountId } = validatedParams(req, accountIdParamsSchema);
      const query = validatedQuery(req, statementQuerySchema);
      if ((await repository.findAccount(deps.pool, accountId)) === undefined) throw new NotFoundError("Compte introuvable.");
      const rows = await repository.accountStatement(deps.pool, { accountId, beforeSeq: query.before, limit: query.limit + 1 });
      const visible = rows.slice(0, query.limit);
      res.json({
        entries: visible.map((row) => ({
          entryId: row.entry_id.toString(),
          sequence: row.account_entry_seq.toString(),
          journalId: row.journal_id,
          journalType: row.journal_type,
          direction: row.direction,
          amount: { amount: row.amount.toString(), currency: row.currency },
          balanceAfter: { amount: row.balance_after.toString(), currency: row.currency },
          description: row.description,
          effectiveAt: row.effective_at.toISOString(),
        })),
        nextCursor: rows.length > query.limit ? (visible.at(-1)?.account_entry_seq.toString() ?? null) : null,
      });
    }),
  );

  router.get(
    "/v1/admin/ledger/journals/:journalId",
    admin,
    canRead,
    validate({ params: journalIdParamsSchema }),
    handle(async (req, res) => {
      const { journalId } = validatedParams(req, journalIdParamsSchema);
      const found = await repository.findJournal(deps.pool, journalId);
      if (found === undefined) throw new NotFoundError("Journal introuvable.");
      const { journal, entries } = found;
      res.json({
        id: journal.id,
        sequence: journal.seq.toString(),
        type: journal.journal_type,
        idempotencyKey: journal.idempotency_key,
        reference: journal.reference_type === null ? null : { type: journal.reference_type, id: journal.reference_id },
        reversesJournalId: journal.reverses_journal_id,
        reversedByJournalId: journal.reversed_by_journal_id,
        description: journal.description,
        metadata: journal.metadata,
        actor: journal.actor,
        effectiveAt: journal.effective_at.toISOString(),
        createdAt: journal.created_at.toISOString(),
        hash: hex(journal.hash),
        previousHash: hex(journal.prev_hash),
        entries: entries.map((entry) => ({
          line: entry.line_no,
          accountId: entry.account_id,
          accountCode: entry.account_code,
          direction: entry.direction,
          amount: { amount: entry.amount.toString(), currency: entry.currency },
          balanceAfter: { amount: entry.balance_after.toString(), currency: entry.currency },
        })),
      });
    }),
  );

  router.get(
    "/v1/admin/ledger/trial-balance",
    admin,
    canRead,
    handle(async (_req, res) => {
      const rows = await repository.trialBalance(deps.pool);
      res.json({
        currencies: rows.map((row) => ({
          currency: row.currency,
          totalDebits: row.total_debits.toString(),
          totalCredits: row.total_credits.toString(),
          debitNormalBalances: row.debit_normal_balances.toString(),
          creditNormalBalances: row.credit_normal_balances.toString(),
          balanced: row.is_balanced,
        })),
      });
    }),
  );

  router.get(
    "/v1/admin/ledger/integrity",
    admin,
    canRead,
    handle(async (_req, res) => {
      const run = await deps.pool.query<{
        id: bigint; started_at: Date; finished_at: Date | null; status: string; verified_from_seq: bigint | null;
        verified_to_seq: bigint | null; chain_head_seq: bigint | null; chain_head_hash: Buffer | null; problems: unknown[];
      }>(
        `SELECT id, started_at, finished_at, status, verified_from_seq, verified_to_seq, chain_head_seq, chain_head_hash, problems
           FROM ledger.reconciliation_runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1`,
      );
      const anchor = await deps.pool.query<{ seq: bigint; hash: Buffer; anchor_target: string; external_reference: string; anchored_at: Date }>(
        "SELECT seq, hash, anchor_target, external_reference, anchored_at FROM ledger.chain_anchors ORDER BY id DESC LIMIT 1",
      );
      const head = await deps.pool.query<{ last_seq: bigint; last_hash: Buffer }>("SELECT last_seq, last_hash FROM ledger.chain_head");
      const lastRun = run.rows[0];
      const lastAnchor = anchor.rows[0];
      const chainHead = head.rows[0];
      res.json({
        chainHead: chainHead === undefined ? null : { sequence: chainHead.last_seq.toString(), hash: hex(chainHead.last_hash) },
        lastReconciliation:
          lastRun === undefined
            ? null
            : {
                id: lastRun.id.toString(),
                status: lastRun.status,
                startedAt: lastRun.started_at.toISOString(),
                finishedAt: lastRun.finished_at?.toISOString() ?? null,
                verifiedFromSequence: lastRun.verified_from_seq?.toString() ?? null,
                verifiedToSequence: lastRun.verified_to_seq?.toString() ?? null,
                problems: lastRun.problems,
              },
        lastAnchor:
          lastAnchor === undefined
            ? null
            : {
                sequence: lastAnchor.seq.toString(),
                hash: hex(lastAnchor.hash),
                target: lastAnchor.anchor_target,
                externalReference: lastAnchor.external_reference,
                anchoredAt: lastAnchor.anchored_at.toISOString(),
              },
      });
    }),
  );

  return router;
}
