import { randomUUID } from "node:crypto";

import type { CountryCode } from "libphonenumber-js/max";

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Queryable } from "../../db/transaction.js";
import { normalizeAccountIdentifier, normalizePhone, NormalizationError } from "../../lib/crypto/blindIndex.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { AppError, ConflictError, NotFoundError, sqlStateOf, ValidationError } from "../../lib/errors.js";
import type { PayoutMethod, RecipientAccount } from "../payments/providers/types.js";
import { operatorsForCountry } from "./recipients.schemas.js";
import type { CreateRecipientInput } from "./recipients.schemas.js";

/**
 * Bénéficiaires.
 *
 * Nom et coordonnées de paiement chiffrés (enveloppe AES-256-GCM, contexte
 * lié à la ligne) ; les coordonnées sont aussi indexées à l'aveugle pour
 * détecter un même compte partagé par de nombreux expéditeurs (typologie de
 * mule financière, phase AML) et les doublons d'un même client. Les
 * coordonnées ne sont jamais modifiées : on archive et on recrée.
 */

export interface RecipientView {
  readonly id: string;
  readonly country: string;
  readonly currency: string;
  readonly payoutMethod: PayoutMethod;
  readonly firstName: string;
  readonly lastName: string;
  readonly displayHint: string;
  readonly mobileOperator: string | null;
  readonly relationship: string | null;
  readonly createdAt: string;
}

/** Bénéficiaire déchiffré, pour l'ordre de paiement sortant uniquement. */
export interface RecipientForPayout {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly account: RecipientAccount;
}

interface RecipientRow {
  id: string;
  country: string;
  currency: string;
  payout_method: PayoutMethod;
  full_name_enc: Buffer;
  account_details_enc: Buffer;
  display_hint: string;
  mobile_operator: string | null;
  relationship: string | null;
  created_at: Date;
}

const OPERATOR_LABELS: Readonly<Record<string, string>> = {
  orange_money: "Orange Money",
  wave: "Wave",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  free_money: "Free Money",
  mpesa: "M-Pesa",
  airtel_money: "Airtel Money",
  vodafone_cash: "Vodafone Cash",
  mynita: "MyNita",
  zamani_cash: "Zamani Cash",
  bankily: "Bankily",
  masrvi: "Masrvi",
  sedad: "Sedad",
  click: "Click",
};

/** Validation ISO 13616 (pays, longueur minimale, clé mod 97). */
export function normalizeIban(input: string): string {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) throw new NormalizationError("IBAN invalide");
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? (char.charCodeAt(0) - 55).toString() : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) throw new NormalizationError("IBAN invalide (clé de contrôle)");
  return iban;
}

export class RecipientService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly encryptor: FieldEncryptor;
      readonly indexer: BlindIndexer;
      readonly piiKeyId: string;
    },
  ) {}

  async create(userId: string, input: CreateRecipientInput): Promise<RecipientView> {
    const country = await this.deps.pool.query<{ can_receive: boolean; currency_enabled: boolean | null }>(
      `SELECT c.can_receive, cur.is_enabled AS currency_enabled
         FROM ref.countries c LEFT JOIN ref.currencies cur ON cur.code = $2
        WHERE c.alpha2 = $1`,
      [input.country, input.currency],
    );
    const reference = country.rows[0];
    if (reference?.can_receive !== true) throw invalid("country", "Ce pays n'est pas ouvert à la réception.");
    if (reference.currency_enabled !== true) throw invalid("currency", "Cette devise n'est pas proposée.");

    const normalized = this.normalizeAccount(input);
    const id = randomUUID();
    const context = (column: string): string => fieldContext("transfers", "recipients", column, id);
    const fullNameEnc = await this.deps.encryptor.encrypt(JSON.stringify({ firstName: input.firstName, lastName: input.lastName }), context("full_name"));
    const accountEnc = await this.deps.encryptor.encrypt(JSON.stringify(normalized.account), context("account_details"));
    const bidx = this.deps.indexer.compute("recipient_account", `${input.country}:${normalized.method}:${normalized.identifier}`);

    try {
      const row = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (client) => {
        const inserted = await client.query<RecipientRow>(
          `INSERT INTO transfers.recipients (id, user_id, country, currency, payout_method, full_name_enc, account_details_enc,
                                            account_details_bidx, display_hint, bank_code, mobile_operator, relationship, pii_key_id)
           VALUES ($1, $2, $3, $4, $5::transfers.payout_method, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id, country, currency, payout_method, full_name_enc, account_details_enc, display_hint, mobile_operator,
                     relationship, created_at`,
          [
            id,
            userId,
            input.country,
            input.currency,
            normalized.method,
            fullNameEnc,
            accountEnc,
            bidx,
            normalized.displayHint,
            normalized.account.kind === "bank_account" ? normalized.account.bankCode : null,
            normalized.account.kind === "mobile_money" ? normalized.account.operator : null,
            input.relationship ?? null,
            this.deps.piiKeyId,
          ],
        );
        const created = inserted.rows[0];
        if (created === undefined) throw new Error("création du bénéficiaire impossible");
        return created;
      });
      return { ...this.publicFields(row), firstName: input.firstName, lastName: input.lastName };
    } catch (error: unknown) {
      if (sqlStateOf(error) === "23505") throw new ConflictError("CONFLICT", "Ce bénéficiaire est déjà enregistré.");
      throw error;
    }
  }

  async list(userId: string): Promise<readonly RecipientView[]> {
    const result = await this.deps.pool.query<RecipientRow>(
      `SELECT id, country, currency, payout_method, full_name_enc, account_details_enc, display_hint, mobile_operator,
              relationship, created_at
         FROM transfers.recipients
        WHERE user_id = $1 AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId],
    );
    return Promise.all(result.rows.map(async (row) => ({ ...this.publicFields(row), ...(await this.decryptName(row)) })));
  }

  async archive(userId: string, recipientId: string): Promise<void> {
    const result = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, (client) =>
      client.query("UPDATE transfers.recipients SET archived_at = now() WHERE id = $1 AND user_id = $2 AND archived_at IS NULL", [recipientId, userId]),
    );
    if (result.rowCount !== 1) throw new NotFoundError("Bénéficiaire introuvable.");
  }

  /** Coordonnées déchiffrées pour l'ordre de paiement (jamais renvoyées au client). */
  async forPayout(db: Queryable, recipientId: string): Promise<RecipientForPayout> {
    const result = await db.query<RecipientRow>(
      `SELECT id, country, currency, payout_method, full_name_enc, account_details_enc, display_hint, mobile_operator,
              relationship, created_at
         FROM transfers.recipients WHERE id = $1`,
      [recipientId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Bénéficiaire introuvable.");
    const name = await this.decryptName(row);
    const account = JSON.parse(
      await this.deps.encryptor.decrypt(row.account_details_enc, fieldContext("transfers", "recipients", "account_details", row.id)),
    ) as RecipientAccount;
    return { id: row.id, ...name, account };
  }

  private normalizeAccount(input: CreateRecipientInput): {
    readonly method: PayoutMethod;
    readonly account: RecipientAccount;
    readonly identifier: string;
    readonly displayHint: string;
  } {
    const account = input.account;
    try {
      switch (account.kind) {
        case "mobile_money":
        case "cash_pickup": {
          const phone = normalizePhone(account.msisdn, input.country as CountryCode);
          if (phone.country !== input.country) throw new NormalizationError("le numéro doit appartenir au pays du bénéficiaire");
          if (account.kind === "mobile_money" && !operatorsForCountry(input.country).includes(account.operator)) {
            throw new NormalizationError("cet opérateur n'est pas disponible dans le pays du bénéficiaire");
          }
          const hint = `•••• ${phone.e164.slice(-4)}`;
          return account.kind === "mobile_money"
            ? {
                method: "mobile_money",
                account: { kind: "mobile_money", msisdn: phone.e164, operator: account.operator },
                identifier: phone.e164,
                displayHint: `${hint} · ${OPERATOR_LABELS[account.operator] ?? account.operator}`,
              }
            : { method: "cash_pickup", account: { kind: "cash_pickup", msisdn: phone.e164 }, identifier: phone.e164, displayHint: `Retrait · ${hint}` };
        }
        case "bank_account": {
          if (account.iban !== undefined) {
            const iban = normalizeIban(account.iban);
            if (iban.slice(0, 2) !== input.country) throw new NormalizationError("l'IBAN doit appartenir au pays du bénéficiaire");
            return { method: "bank_account", account: { kind: "bank_account", iban, accountNumber: null, bankCode: null }, identifier: iban, displayHint: `•••• ${iban.slice(-4)}` };
          }
          const accountNumber = normalizeAccountIdentifier(account.accountNumber ?? "");
          const bankCode = normalizeAccountIdentifier(account.bankCode ?? "");
          return {
            method: "bank_account",
            account: { kind: "bank_account", iban: null, accountNumber, bankCode },
            identifier: `${bankCode}:${accountNumber}`,
            displayHint: `•••• ${accountNumber.slice(-4)}`,
          };
        }
      }
    } catch (error: unknown) {
      if (error instanceof NormalizationError) throw invalid("account", error.message);
      throw error;
    }
  }

  private async decryptName(row: RecipientRow): Promise<{ readonly firstName: string; readonly lastName: string }> {
    const parsed = JSON.parse(await this.deps.encryptor.decrypt(row.full_name_enc, fieldContext("transfers", "recipients", "full_name", row.id))) as {
      firstName: string;
      lastName: string;
    };
    return { firstName: parsed.firstName, lastName: parsed.lastName };
  }

  private publicFields(row: RecipientRow): Omit<RecipientView, "firstName" | "lastName"> {
    return {
      id: row.id,
      country: row.country,
      currency: row.currency,
      payoutMethod: row.payout_method,
      displayHint: row.display_hint,
      mobileOperator: row.mobile_operator,
      relationship: row.relationship,
      createdAt: row.created_at.toISOString(),
    };
  }
}

function invalid(path: string, message: string): AppError {
  return new ValidationError([{ path: `body.${path}`, message }], message);
}
