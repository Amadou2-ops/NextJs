import type { Queryable } from "../../db/transaction.js";
import type { CustomerAccountType, EntryDirection, JournalType, PaymentProvider, SystemAccountType } from "./ledger.types.js";

/**
 * Accès SQL au registre. Les écritures passent exclusivement par les
 * fonctions de la base (ledger.post_journal / ledger.reverse_journal) ;
 * aucune requête de ce module n'écrit directement dans les tables.
 *
 * Les montants transitent en bigint[] PostgreSQL (chaînes côté JavaScript) :
 * ils ne sont jamais convertis en nombre flottant, et le JSON des écritures
 * est construit côté base.
 */

export interface EntryInput {
  readonly accountId: string;
  readonly direction: EntryDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface JournalInput {
  readonly idempotencyKey: string;
  readonly journalType: Exclude<JournalType, "reversal">;
  readonly entries: readonly EntryInput[];
  readonly description: string;
  readonly actor: string;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly effectiveAt?: Date;
}

export async function postJournal(db: Queryable, input: JournalInput): Promise<string> {
  const result = await db.query<{ journal_id: string }>(
    `SELECT ledger.post_journal(
              $1,
              $2::ledger.journal_type,
              (SELECT jsonb_agg(jsonb_build_object('account_id', t.account_id, 'direction', t.direction,
                                                   'amount', t.amount, 'currency', t.currency) ORDER BY t.ord)
                 FROM unnest($3::uuid[], $4::text[], $5::bigint[], $6::text[]) WITH ORDINALITY
                      AS t(account_id, direction, amount, currency, ord)),
              $7, $8, $9, $10::uuid, $11::jsonb, $12::timestamptz
            ) AS journal_id`,
    [
      input.idempotencyKey,
      input.journalType,
      input.entries.map((entry) => entry.accountId),
      input.entries.map((entry) => entry.direction),
      input.entries.map((entry) => entry.amountMinor.toString()),
      input.entries.map((entry) => entry.currency),
      input.description,
      input.actor,
      input.referenceType ?? null,
      input.referenceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.effectiveAt?.toISOString() ?? null,
    ],
  );
  const journalId = result.rows[0]?.journal_id;
  if (journalId === undefined) throw new Error("ledger.post_journal n'a renvoyé aucun journal");
  return journalId;
}

export async function reverseJournal(
  db: Queryable,
  params: { readonly journalId: string; readonly idempotencyKey: string; readonly reason: string; readonly actor: string },
): Promise<string> {
  const result = await db.query<{ journal_id: string }>(
    "SELECT ledger.reverse_journal($1, $2, $3, $4) AS journal_id",
    [params.journalId, params.idempotencyKey, params.reason, params.actor],
  );
  const journalId = result.rows[0]?.journal_id;
  if (journalId === undefined) throw new Error("ledger.reverse_journal n'a renvoyé aucun journal");
  return journalId;
}

export async function openCustomerAccount(db: Queryable, userId: string, type: CustomerAccountType, currency: string): Promise<string> {
  const result = await db.query<{ id: string }>("SELECT ledger.open_customer_account($1, $2::ledger.account_type, $3) AS id", [userId, type, currency]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("ouverture de compte client impossible");
  return id;
}

export async function openSystemAccount(db: Queryable, type: SystemAccountType, currency: string, provider: PaymentProvider | null): Promise<string> {
  const result = await db.query<{ id: string }>(
    "SELECT ledger.open_system_account($1::ledger.account_type, $2, $3::payments.provider) AS id",
    [type, currency, provider],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("ouverture de compte système impossible");
  return id;
}

export interface CustomerBalanceRow {
  readonly currency: string;
  readonly minor_units: number;
  readonly available: bigint;
  readonly held: bigint;
}

export async function customerBalances(db: Queryable, userId: string): Promise<readonly CustomerBalanceRow[]> {
  const result = await db.query<CustomerBalanceRow>(
    `SELECT b.currency, c.minor_units, b.available, b.held
       FROM ledger.customer_balances b
       JOIN ref.currencies c ON c.code = b.currency
      WHERE b.user_id = $1
      ORDER BY b.currency`,
    [userId],
  );
  return result.rows;
}

export async function findCustomerAccountId(db: Queryable, userId: string, type: CustomerAccountType, currency: string): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM ledger.accounts WHERE owner_user_id = $1 AND account_type = $2::ledger.account_type AND currency = $3",
    [userId, type, currency],
  );
  return result.rows[0]?.id;
}

export interface StatementRow {
  readonly entry_id: bigint;
  readonly account_entry_seq: bigint;
  readonly direction: EntryDirection;
  readonly amount: bigint;
  readonly currency: string;
  readonly balance_after: bigint;
  readonly journal_id: string;
  readonly journal_type: JournalType;
  readonly description: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly reverses_journal_id: string | null;
  readonly effective_at: Date;
  readonly created_at: Date;
}

/** Relevé d'un compte, du plus récent au plus ancien, paginé par numéro d'ordre. */
export async function accountStatement(
  db: Queryable,
  params: { readonly accountId: string; readonly beforeSeq: bigint | undefined; readonly limit: number },
): Promise<readonly StatementRow[]> {
  const result = await db.query<StatementRow>(
    `SELECT e.id AS entry_id, e.account_entry_seq, e.direction, e.amount, e.currency, e.balance_after,
            j.id AS journal_id, j.journal_type, j.description, j.reference_type, j.reference_id::text,
            j.reverses_journal_id, j.effective_at, e.created_at
       FROM ledger.entries e
       JOIN ledger.journals j ON j.id = e.journal_id
      WHERE e.account_id = $1
        AND ($2::bigint IS NULL OR e.account_entry_seq < $2::bigint)
      ORDER BY e.account_entry_seq DESC
      LIMIT $3`,
    [params.accountId, params.beforeSeq?.toString() ?? null, params.limit],
  );
  return result.rows;
}

export interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly account_type: string;
  readonly normal_side: EntryDirection;
  readonly currency: string;
  readonly owner_user_id: string | null;
  readonly provider: PaymentProvider | null;
  readonly status: string;
  readonly status_reason: string | null;
  readonly allow_negative: boolean;
  readonly balance: bigint;
  readonly last_entry_seq: bigint;
  readonly created_at: Date;
}

export async function findAccount(db: Queryable, accountId: string): Promise<AccountRow | undefined> {
  const result = await db.query<AccountRow>(
    `SELECT a.id, a.code, a.account_type, a.normal_side, a.currency, a.owner_user_id, a.provider, a.status,
            a.status_reason, a.allow_negative, b.balance, b.last_entry_seq, a.created_at
       FROM ledger.accounts a
       JOIN ledger.account_balances b ON b.account_id = a.id
      WHERE a.id = $1`,
    [accountId],
  );
  return result.rows[0];
}

export interface JournalRow {
  readonly id: string;
  readonly seq: bigint;
  readonly journal_type: JournalType;
  readonly idempotency_key: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly reverses_journal_id: string | null;
  readonly reversed_by_journal_id: string | null;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly actor: string;
  readonly effective_at: Date;
  readonly created_at: Date;
  readonly hash: Buffer;
  readonly prev_hash: Buffer;
}

export interface JournalEntryRow {
  readonly line_no: number;
  readonly account_id: string;
  readonly account_code: string;
  readonly direction: EntryDirection;
  readonly amount: bigint;
  readonly currency: string;
  readonly balance_after: bigint;
}

export async function findJournal(db: Queryable, journalId: string): Promise<{ readonly journal: JournalRow; readonly entries: readonly JournalEntryRow[] } | undefined> {
  const journal = await db.query<JournalRow>(
    `SELECT j.id, j.seq, j.journal_type, j.idempotency_key, j.reference_type, j.reference_id::text, j.reverses_journal_id,
            r.id AS reversed_by_journal_id, j.description, j.metadata, j.actor, j.effective_at, j.created_at, j.hash, j.prev_hash
       FROM ledger.journals j
       LEFT JOIN ledger.journals r ON r.reverses_journal_id = j.id
      WHERE j.id = $1`,
    [journalId],
  );
  const row = journal.rows[0];
  if (row === undefined) return undefined;
  const entries = await db.query<JournalEntryRow>(
    `SELECT e.line_no, e.account_id, a.code AS account_code, e.direction, e.amount, e.currency, e.balance_after
       FROM ledger.entries e JOIN ledger.accounts a ON a.id = e.account_id
      WHERE e.journal_id = $1 ORDER BY e.line_no`,
    [journalId],
  );
  return { journal: row, entries: entries.rows };
}

export interface TrialBalanceRow {
  readonly currency: string;
  readonly total_debits: bigint;
  readonly total_credits: bigint;
  readonly debit_normal_balances: bigint;
  readonly credit_normal_balances: bigint;
  readonly is_balanced: boolean;
}

export async function trialBalance(db: Queryable): Promise<readonly TrialBalanceRow[]> {
  const result = await db.query<TrialBalanceRow>(
    `SELECT currency, total_debits::bigint, total_credits::bigint, debit_normal_balances::bigint,
            credit_normal_balances::bigint, is_balanced
       FROM ledger.trial_balance ORDER BY currency`,
  );
  return result.rows;
}
