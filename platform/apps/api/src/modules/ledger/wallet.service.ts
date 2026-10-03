import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { Money, parseCurrencyCode } from "../../lib/money.js";
import type { MoneyJson } from "../../lib/money.js";
import * as repository from "./ledger.repository.js";
import type { LedgerService } from "./ledger.service.js";
import type { EntryDirection, JournalType } from "./ledger.types.js";

/**
 * Portefeuilles clients : soldes disponibles et réservés par devise, relevés.
 * Lecture seule sur le registre, à l'exception de l'ouverture d'un
 * portefeuille (création des comptes, sans mouvement).
 */

export interface WalletView {
  readonly currency: string;
  readonly minorUnits: number;
  readonly available: MoneyJson;
  readonly held: MoneyJson;
}

export interface StatementEntryView {
  readonly entryId: string;
  readonly sequence: string;
  readonly type: JournalType;
  readonly direction: "in" | "out";
  readonly amount: MoneyJson;
  readonly balanceAfter: MoneyJson;
  readonly description: string;
  readonly reference: { readonly type: string; readonly id: string } | null;
  readonly isReversal: boolean;
  readonly effectiveAt: string;
}

export const STATEMENT_MAX_PAGE_SIZE = 100;

/** Un crédit augmente un portefeuille (compte à solde créditeur). */
function walletDirection(direction: EntryDirection): "in" | "out" {
  return direction === "credit" ? "in" : "out";
}

export class WalletService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly ledger: LedgerService,
  ) {}

  async list(userId: string): Promise<readonly WalletView[]> {
    const rows = await repository.customerBalances(this.pool, userId);
    return rows.map((row) => {
      const currency = parseCurrencyCode(row.currency);
      return {
        currency: row.currency,
        minorUnits: row.minor_units,
        available: Money.ofMinor(row.available, currency).toJSON(),
        held: Money.ofMinor(row.held, currency).toJSON(),
      };
    });
  }

  /** Ouvre (idempotent) le portefeuille et le compte de réservation d'une devise ouverte. */
  async open(userId: string, currencyCode: string): Promise<WalletView> {
    const currency = parseCurrencyCode(currencyCode);
    const enabled = await this.pool.query("SELECT 1 FROM ref.currencies WHERE code = $1 AND is_enabled", [currency]);
    if (enabled.rowCount !== 1) {
      throw new AppError("VALIDATION_FAILED", 422, "Devise indisponible", { detail: `La devise ${currency} n'est pas proposée.` });
    }
    await withTransaction(this.pool, { actor: { type: "customer", id: userId } }, async (tx) => {
      await this.ledger.customerAccount(tx, userId, "customer_wallet", currency);
      await this.ledger.customerAccount(tx, userId, "customer_hold", currency);
    });
    const wallet = (await this.list(userId)).find((item) => item.currency === currency);
    if (wallet === undefined) throw new Error("portefeuille ouvert introuvable");
    return wallet;
  }

  async statement(
    userId: string,
    currencyCode: string,
    page: { readonly before?: bigint; readonly limit: number },
  ): Promise<{ readonly entries: readonly StatementEntryView[]; readonly nextCursor: string | null }> {
    const currency = parseCurrencyCode(currencyCode);
    const accountId = await repository.findCustomerAccountId(this.pool, userId, "customer_wallet", currency);
    if (accountId === undefined) throw new NotFoundError(`Aucun portefeuille en ${currency}.`);
    const limit = Math.min(Math.max(page.limit, 1), STATEMENT_MAX_PAGE_SIZE);
    const rows = await repository.accountStatement(this.pool, { accountId, beforeSeq: page.before, limit: limit + 1 });
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      entries: visible.map((row) => ({
        entryId: row.entry_id.toString(),
        sequence: row.account_entry_seq.toString(),
        type: row.journal_type,
        direction: walletDirection(row.direction),
        amount: Money.ofMinor(row.amount, currency).toJSON(),
        balanceAfter: Money.ofMinor(row.balance_after, currency).toJSON(),
        description: row.description,
        reference: row.reference_type === null || row.reference_id === null ? null : { type: row.reference_type, id: row.reference_id },
        isReversal: row.reverses_journal_id !== null,
        effectiveAt: row.effective_at.toISOString(),
      })),
      nextCursor: rows.length > limit && last !== undefined ? last.account_entry_seq.toString() : null,
    };
  }
}
