import type { Queryable } from "../../db/transaction.js";
import type { Money } from "../../lib/money.js";
import * as repository from "./ledger.repository.js";
import type { CustomerAccountType, EntryDirection, JournalType, PaymentProvider, SystemAccountType } from "./ledger.types.js";
import { PROVIDER_SCOPED_ACCOUNT_TYPES } from "./ledger.types.js";

/**
 * Service du registre : interface typée pour les modules métier (transferts,
 * paiements, remboursements). Il vérifie localement l'équilibre des écritures
 * avant de les envoyer — la base revérifie tout, mais une écriture
 * déséquilibrée est d'abord un défaut de programmation, détecté au plus tôt.
 */

export interface Posting {
  readonly accountId: string;
  readonly direction: EntryDirection;
  readonly money: Money;
}

export interface JournalRequest {
  /** Clé déterministe dérivée de l'opération métier, ex. « transfer:<id>:hold ». */
  readonly idempotencyKey: string;
  readonly journalType: Exclude<JournalType, "reversal">;
  readonly postings: readonly Posting[];
  readonly description: string;
  readonly actor: string;
  readonly reference?: { readonly type: string; readonly id: string };
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly effectiveAt?: Date;
}

export class LedgerProgrammingError extends Error {
  override readonly name = "LedgerProgrammingError";
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_.-]{8,200}$/;

export function assertBalanced(postings: readonly Posting[]): void {
  if (postings.length < 2 || postings.length > 100) {
    throw new LedgerProgrammingError(`un journal comporte de 2 à 100 écritures (${postings.length})`);
  }
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  const sides = new Map<string, Set<EntryDirection>>();
  for (const posting of postings) {
    if (posting.money.amountMinor <= 0n) throw new LedgerProgrammingError("montant d'écriture nul");
    const total = totals.get(posting.money.currency) ?? { debit: 0n, credit: 0n };
    total[posting.direction] += posting.money.amountMinor;
    totals.set(posting.money.currency, total);
    const accountSides = sides.get(posting.accountId) ?? new Set<EntryDirection>();
    accountSides.add(posting.direction);
    if (accountSides.size > 1) throw new LedgerProgrammingError(`le compte ${posting.accountId} est débité et crédité dans le même journal`);
    sides.set(posting.accountId, accountSides);
  }
  for (const [currency, total] of totals) {
    if (total.debit !== total.credit) {
      throw new LedgerProgrammingError(`journal déséquilibré en ${currency} : débits ${total.debit}, crédits ${total.credit}`);
    }
  }
}

export class LedgerService {
  /** Identifiants des comptes système (immuables une fois créés). */
  private readonly systemAccounts = new Map<string, string>();

  async post(db: Queryable, request: JournalRequest): Promise<string> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)) {
      throw new LedgerProgrammingError(`clé d'idempotence invalide : ${request.idempotencyKey}`);
    }
    assertBalanced(request.postings);
    return repository.postJournal(db, {
      idempotencyKey: request.idempotencyKey,
      journalType: request.journalType,
      entries: request.postings.map((posting) => ({
        accountId: posting.accountId,
        direction: posting.direction,
        amountMinor: posting.money.amountMinor,
        currency: posting.money.currency,
      })),
      description: request.description,
      actor: request.actor,
      ...(request.reference === undefined ? {} : { referenceType: request.reference.type, referenceId: request.reference.id }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      ...(request.effectiveAt === undefined ? {} : { effectiveAt: request.effectiveAt }),
    });
  }

  reverse(db: Queryable, params: { readonly journalId: string; readonly idempotencyKey: string; readonly reason: string; readonly actor: string }): Promise<string> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(params.idempotencyKey)) {
      throw new LedgerProgrammingError(`clé d'idempotence invalide : ${params.idempotencyKey}`);
    }
    return repository.reverseJournal(db, params);
  }

  customerAccount(db: Queryable, userId: string, type: CustomerAccountType, currency: string): Promise<string> {
    return repository.openCustomerAccount(db, userId, type, currency);
  }

  async systemAccount(db: Queryable, type: SystemAccountType, currency: string, provider: PaymentProvider | null = null): Promise<string> {
    if (PROVIDER_SCOPED_ACCOUNT_TYPES.has(type) !== (provider !== null)) {
      throw new LedgerProgrammingError(`le compte ${type} ${provider === null ? "exige" : "n'accepte pas"} de prestataire`);
    }
    const key = `${type}:${currency}:${provider ?? "-"}`;
    const cached = this.systemAccounts.get(key);
    if (cached !== undefined) return cached;
    const id = await repository.openSystemAccount(db, type, currency, provider);
    this.systemAccounts.set(key, id);
    return id;
  }
}
