import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AuthContext } from "../../auth/authContext.js";
import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { TransactionClient } from "../../db/transaction.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "../../lib/errors.js";
import { Money, parseCurrencyCode } from "../../lib/money.js";
import type { MoneyJson } from "../../lib/money.js";
import type { ComplianceService } from "../aml/compliance.service.js";
import type { MfaService } from "../auth/mfa.service.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import type { CircuitBreaker } from "../payments/circuitBreaker.js";
import { PaymentProviderError } from "../payments/providers/types.js";
import type { FundingAction, PayinProvider, PaymentProviderName } from "../payments/providers/types.js";
import { payinRoutes } from "../payments/routing.js";
import type { PaymentOrchestrator } from "./payment.orchestrator.js";
import { ACTIVE_ATTEMPT_STATUSES, ATTEMPT_COLUMNS, TRANSFER_COLUMNS } from "./transfer.types.js";
import type { AttemptRow, PurposeCode, TransferRow, TransferStatus } from "./transfer.types.js";

/**
 * Transferts du client : création à partir d'un devis garanti, suivi,
 * reprise du paiement, annulation.
 *
 * Création :
 *   - autorisation renforcée obligatoire : requête signée par l'appareil
 *     (mobile) ou code TOTP consommé dans la même transaction (web) ;
 *   - la base vérifie le devis (montants, consommation unique, expiration),
 *     le bénéficiaire, les plafonds KYC (sous verrou du client) ;
 *   - financement par le portefeuille : réservation immédiate dans la même
 *     transaction (solde insuffisant = rien n'est créé) ;
 *   - financement externe : tentative d'encaissement enregistrée avant
 *     l'appel au prestataire, dont la réponse donne l'action de paiement.
 *   - idempotence : la clé Idempotency-Key est unique par client ; une
 *     requête rejouée renvoie le même transfert.
 */

export interface TransferView {
  readonly id: string;
  readonly reference: string;
  readonly status: TransferStatus;
  readonly statusReason: string | null;
  readonly recipient: { readonly id: string; readonly displayHint: string };
  readonly sendAmount: MoneyJson;
  readonly fee: MoneyJson;
  readonly totalToPay: MoneyJson;
  readonly receiveAmount: MoneyJson;
  readonly exchangeRate: string;
  readonly fundingMethod: TransferRow["funding_method"];
  readonly payoutMethod: TransferRow["payout_method"];
  readonly purposeCode: string;
  readonly createdAt: string;
  readonly fundedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly refundedAt: string | null;
}

export interface TransferDetail extends TransferView {
  readonly history: readonly { readonly status: TransferStatus; readonly at: string }[];
}

export interface CreatedTransfer {
  readonly transfer: TransferView;
  readonly funding: FundingAction | null;
  readonly replayed: boolean;
}

export interface CreateTransferInput {
  readonly quoteId: string;
  readonly recipientId: string;
  readonly purposeCode: PurposeCode;
  readonly idempotencyKey: string;
  readonly totpCode?: string | undefined;
}

type ViewRow = TransferRow & { display_hint: string };

/** Moyens de paiement dont la page hébergée exige l'e-mail du payeur. */
const EMAIL_REQUIRED: ReadonlySet<PaymentProviderName> = new Set(["flutterwave"]);

export class TransferService {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly logger: Logger;
      readonly ledger: LedgerService;
      readonly mfa: MfaService;
      readonly encryptor: FieldEncryptor;
      readonly breaker: CircuitBreaker;
      readonly payinProviders: ReadonlyMap<PaymentProviderName, PayinProvider>;
      readonly orchestrator: PaymentOrchestrator;
      readonly compliance: ComplianceService;
      /** "inline" : le paiement sortant est déclenché avant la réponse (tests) ; sinon en arrière-plan. */
      readonly dispatch: "inline" | "background";
    },
  ) {}

  async create(auth: AuthContext, input: CreateTransferInput): Promise<CreatedTransfer> {
    const userId = auth.subjectId;
    const replay = await this.findByIdempotencyKey(userId, input.idempotencyKey);
    if (replay !== null) {
      if (replay.quote_id !== input.quoteId || replay.recipient_id !== input.recipientId) {
        throw new ConflictError("IDEMPOTENCY_CONFLICT", "Cette clé d'idempotence a déjà servi pour un autre transfert.", 422);
      }
      return { transfer: await this.view(replay.id), funding: await this.resumableFunding(replay.id), replayed: true };
    }

    if (auth.audience === "web" && (input.totpCode === undefined || input.totpCode.length === 0)) {
      throw new ForbiddenError("Confirmez le transfert avec le code de votre application d'authentification.", { reason: "totp_required" });
    }

    const quote = await this.deps.pool.query<{ funding_method: TransferRow["funding_method"]; source_country: string; source_currency: string; total_debit: bigint }>(
      "SELECT funding_method, source_country, source_currency, total_debit FROM fx.quotes WHERE id = $1 AND user_id = $2",
      [input.quoteId, userId],
    );
    const quoted = quote.rows[0];
    if (quoted === undefined) throw new NotFoundError("Devis introuvable.");

    const external = quoted.funding_method !== "wallet_balance";
    const payer = external ? await this.payerProfile(userId) : null;
    const route = external && payer !== null ? await this.selectPayinRoute(quoted, payer.email !== null) : null;

    const created = await withTransaction(this.deps.pool, { actor: { type: "customer", id: userId } }, async (client) => {
      const authorization =
        auth.audience === "mobile"
          ? { method: "device_signature", deviceId: auth.deviceId }
          : { method: "totp", deviceId: null as string | null };
      if (auth.audience !== "mobile" && !(await this.deps.mfa.verifyAndConsumeTotp(client, userId, input.totpCode ?? ""))) {
        throw new AppError("INVALID_VERIFICATION_CODE", 422, "Code incorrect", { detail: "Le code de l'application d'authentification est incorrect." });
      }

      const inserted = await client.query<{ id: string; reference: string }>(
        `INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency,
                                          destination_currency, source_amount, fee_amount, total_debit, destination_amount,
                                          customer_rate, usd_equivalent, funding_method, payout_method, purpose_code,
                                          idempotency_key, authorization_method, authorized_at, authorized_device_id,
                                          authorization_evidence)
         SELECT $8::uuid, $2, q.id, q.source_country, q.destination_country, q.source_currency, q.destination_currency,
                q.source_amount, q.fee_amount, q.total_debit, q.destination_amount, q.customer_rate, q.usd_equivalent,
                q.funding_method, q.payout_method, $3, $4, $5, now(), $6, $7::jsonb
           FROM fx.quotes q
          WHERE q.id = $1 AND q.user_id = $8
         RETURNING id, reference`,
        [
          input.quoteId,
          input.recipientId,
          input.purposeCode,
          input.idempotencyKey,
          authorization.method,
          authorization.deviceId,
          JSON.stringify({ session_id: auth.sessionId, audience: auth.audience, assurance_level: auth.assuranceLevel }),
          userId,
        ],
      );
      const transfer = inserted.rows[0];
      if (transfer === undefined) throw new NotFoundError("Devis introuvable.");

      if (!external) {
        await this.fundFromWallet(client, transfer.id);
        return { id: transfer.id, attemptId: null };
      }
      if (route === null) throw new Error("route d'encaissement absente");
      await client.query("UPDATE transfers.transfers SET status = 'awaiting_funding' WHERE id = $1", [transfer.id]);
      const attemptId = randomUUID();
      await client.query(
        `INSERT INTO payments.attempts (id, transfer_id, direction, provider, payin_method_id, idempotency_key, amount, currency)
         SELECT $1, t.id, 'payin', $3::payments.provider, $4, $5, t.total_debit, t.source_currency
           FROM transfers.transfers t WHERE t.id = $2`,
        [attemptId, transfer.id, route.provider, route.id, `pi-${attemptId}`],
      );
      await this.emit(client, transfer.id, "transfers.created", { funding: "external", provider: route.provider });
      return { id: transfer.id, attemptId };
    });

    if (created.attemptId === null) {
      if (this.deps.dispatch === "inline") {
        await this.deps.orchestrator.dispatchPayout(created.id);
      } else {
        setImmediate(() => {
          this.deps.orchestrator.dispatchPayout(created.id).catch((error: unknown) => {
            this.deps.logger.error({ err: error, transferId: created.id }, "paiement sortant non déclenché (reprise par le worker)");
          });
        });
      }
      return { transfer: await this.view(created.id), funding: null, replayed: false };
    }

    const funding = await this.openPayin(created.attemptId, payer);
    return { transfer: await this.view(created.id), funding, replayed: false };
  }

  async list(userId: string, params: { readonly limit: number; readonly before: Date | undefined }): Promise<{ readonly transfers: readonly TransferView[]; readonly nextCursor: string | null }> {
    const result = await this.deps.pool.query<ViewRow>(
      `SELECT ${TRANSFER_COLUMNS}, r.display_hint
         FROM transfers.transfers t JOIN transfers.recipients r ON r.id = t.recipient_id
        WHERE t.user_id = $1 AND ($2::timestamptz IS NULL OR t.created_at < $2)
        ORDER BY t.created_at DESC
        LIMIT $3`,
      [userId, params.before ?? null, params.limit + 1],
    );
    const rows = result.rows.slice(0, params.limit);
    const last = rows[rows.length - 1];
    return {
      transfers: rows.map((row) => present(row)),
      nextCursor: result.rows.length > params.limit && last !== undefined ? last.created_at.toISOString() : null,
    };
  }

  async get(userId: string, transferId: string): Promise<TransferDetail> {
    const row = await this.loadOwned(userId, transferId);
    const history = await this.deps.pool.query<{ to_status: TransferStatus; created_at: Date }>(
      "SELECT to_status, created_at FROM transfers.status_history WHERE transfer_id = $1 ORDER BY id",
      [transferId],
    );
    return { ...present(row), history: history.rows.map((entry) => ({ status: entry.to_status, at: entry.created_at.toISOString() })) };
  }

  /** Action de paiement à jour pour un transfert en attente de financement. */
  async funding(userId: string, transferId: string): Promise<{ readonly funding: FundingAction }> {
    const row = await this.loadOwned(userId, transferId);
    if (row.status !== "awaiting_funding") throw new ConflictError("CONFLICT", "Ce transfert n'attend pas de paiement.");
    const action = await this.resumableFunding(transferId);
    if (action === null) throw new ConflictError("CONFLICT", "Aucun paiement en attente pour ce transfert.");
    return { funding: action };
  }

  async cancel(userId: string, transferId: string): Promise<TransferView> {
    const row = await this.loadOwned(userId, transferId);
    const actor = { type: "customer" as const, id: userId };
    if (row.status === "created" || row.status === "awaiting_funding") {
      const outcome = await this.deps.orchestrator.cancelFunding(transferId, "cancelled_by_customer", actor);
      if (outcome !== "cancelled") throw new ConflictError("CONFLICT", "Le paiement de ce transfert a déjà été effectué ou est en cours de traitement.");
    } else if (row.status === "funded" || row.status === "payout_pending") {
      if (!(await this.deps.orchestrator.refundBeforePayout(transferId, actor))) {
        throw new ConflictError("CONFLICT", "Le paiement au bénéficiaire est déjà en cours : le transfert ne peut plus être annulé.");
      }
    } else {
      throw new ConflictError("CONFLICT", "Ce transfert ne peut plus être annulé.");
    }
    return this.view(transferId);
  }

  // ---------------------------------------------------------------------------

  private async fundFromWallet(client: TransactionClient, transferId: string): Promise<void> {
    const result = await client.query<TransferRow>(`SELECT ${TRANSFER_COLUMNS} FROM transfers.transfers t WHERE t.id = $1 FOR UPDATE`, [transferId]);
    const transfer = result.rows[0];
    if (transfer === undefined) throw new Error("transfert introuvable");
    const currency = parseCurrencyCode(transfer.source_currency);
    const wallet = await this.deps.ledger.customerAccount(client, transfer.user_id, "customer_wallet", transfer.source_currency);
    const hold = await this.deps.ledger.customerAccount(client, transfer.user_id, "customer_hold", transfer.source_currency);
    // Solde insuffisant : LG001, la création entière est annulée.
    await this.deps.ledger.post(client, {
      idempotencyKey: `transfer:${transfer.id}:funding`,
      journalType: "transfer_hold",
      postings: [
        { accountId: wallet, direction: "debit", money: Money.ofMinor(transfer.total_debit, currency) },
        { accountId: hold, direction: "credit", money: Money.ofMinor(transfer.total_debit, currency) },
      ],
      description: `Réservation sur portefeuille — ${transfer.reference}`,
      actor: `customer:${transfer.user_id}`,
      reference: { type: "transfer", id: transfer.id },
    });
    await client.query("UPDATE transfers.transfers SET status = 'funded' WHERE id = $1", [transfer.id]);
    await this.emit(client, transfer.id, "transfers.created", { funding: "wallet_balance" });
    await this.emit(client, transfer.id, "transfers.funded", { funding: "wallet_balance" });
    // Évaluation AML avant tout paiement : payout_pending ou compliance_review.
    await this.deps.compliance.evaluateAndRoute(client, transfer.id);
  }

  private async selectPayinRoute(
    quote: { readonly funding_method: TransferRow["funding_method"]; readonly source_country: string; readonly source_currency: string; readonly total_debit: bigint },
    hasEmail: boolean,
  ): Promise<{ readonly id: string; readonly provider: PaymentProviderName }> {
    const routes = await payinRoutes(this.deps.pool, {
      country: quote.source_country,
      currency: quote.source_currency,
      fundingMethod: quote.funding_method,
      amountMinor: quote.total_debit,
    });
    let emailBlocked = false;
    for (const route of routes) {
      if (!this.deps.payinProviders.has(route.provider)) continue;
      if (EMAIL_REQUIRED.has(route.provider) && !hasEmail) {
        emailBlocked = true;
        continue;
      }
      if (await this.deps.breaker.canUse(route.provider)) return route;
    }
    if (emailBlocked) {
      throw new AppError("VALIDATION_FAILED", 422, "Adresse e-mail requise", {
        detail: "Ce moyen de paiement exige une adresse e-mail vérifiée sur votre compte.",
      });
    }
    throw new ServiceUnavailableError("Ce moyen de paiement est momentanément indisponible. Choisissez-en un autre ou réessayez plus tard.", undefined, 300);
  }

  private async openPayin(attemptId: string, payer: PayerProfile | null): Promise<FundingAction> {
    const attempt = await this.loadAttempt(attemptId);
    const provider = this.deps.payinProviders.get(attempt.provider);
    if (provider === undefined || payer === null) throw new Error("encaissement impossible à ouvrir");
    const transfer = await this.deps.pool.query<{ reference: string; funding_method: TransferRow["funding_method"] }>(
      "SELECT reference, funding_method FROM transfers.transfers WHERE id = $1",
      [attempt.transfer_id],
    );
    const meta = transfer.rows[0];
    if (meta === undefined || meta.funding_method === "wallet_balance") throw new Error("transfert sans financement externe");
    const fundingMethod = meta.funding_method;
    try {
      const session = await this.deps.breaker.run(attempt.provider, async () =>
        provider.createPayin({
          attemptId: attempt.id,
          idempotencyKey: attempt.idempotency_key,
          transferId: attempt.transfer_id,
          transferReference: meta.reference,
          amountMinor: attempt.amount,
          currency: attempt.currency,
          minorUnits: await this.deps.orchestrator.units(attempt.currency),
          fundingMethod,
          customer: payer,
        }),
      );
      await this.deps.pool.query(
        `UPDATE payments.attempts
            SET provider_reference = COALESCE(provider_reference, $2),
                status = CASE WHEN status = 'pending' THEN 'requires_action'::payments.attempt_status ELSE status END,
                provider_response = provider_response || $3::jsonb
          WHERE id = $1`,
        [attempt.id, session.providerReference, JSON.stringify({ ...session.status.summary, ...session.resumable, stage: "checkout_created" })],
      );
      return session.action;
    } catch (error: unknown) {
      const definitive = error instanceof PaymentProviderError && !error.retryable && !error.outcomeUnknown;
      this.deps.logger.error({ err: error, attemptId }, "ouverture du paiement impossible");
      if (definitive) {
        await this.deps.orchestrator.applyPayinStatus(attempt.id, {
          status: "failed",
          providerReference: null,
          amount: null,
          fee: null,
          failureCode: error.providerCode ?? "payin_rejected",
          failureMessage: error.message.slice(0, 200),
          summary: { stage: "checkout_rejected" },
        });
        throw new AppError("VALIDATION_FAILED", 422, "Paiement refusé", { detail: "Le prestataire de paiement a refusé l'opération. Le transfert a été annulé." });
      }
      // Issue incertaine : la même requête (même Idempotency-Key) reprendra l'ouverture.
      await this.deps.pool.query("UPDATE payments.attempts SET provider_response = provider_response || $2::jsonb WHERE id = $1", [
        attempt.id,
        JSON.stringify({ stage: "checkout_retry" }),
      ]);
      throw new ServiceUnavailableError("Le paiement n'a pas pu être ouvert. Réessayez avec la même requête.", error, 10);
    }
  }

  private async resumableFunding(transferId: string): Promise<FundingAction | null> {
    const attempts = await this.deps.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.transfer_id = $1 AND a.direction = 'payin' ORDER BY a.created_at DESC LIMIT 1`,
      [transferId],
    );
    const attempt = attempts.rows[0];
    if (attempt === undefined || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return null;
    const provider = this.deps.payinProviders.get(attempt.provider);
    if (provider === undefined) return null;
    if (attempt.provider_reference === null) {
      const transfer = await this.deps.pool.query<{ user_id: string }>("SELECT user_id FROM transfers.transfers WHERE id = $1", [transferId]);
      const userId = transfer.rows[0]?.user_id;
      if (userId === undefined) return null;
      return this.openPayin(attempt.id, await this.payerProfile(userId));
    }
    const reference = attempt.provider_reference;
    return this.deps.breaker.run(attempt.provider, () => provider.resumePayin({ providerReference: reference, resumable: attempt.provider_response }));
  }

  private async payerProfile(userId: string): Promise<PayerProfile> {
    const result = await this.deps.pool.query<{ phone_enc: Buffer; email_enc: Buffer | null; first_name_enc: Buffer | null; last_name_enc: Buffer | null }>(
      "SELECT phone_enc, email_enc, first_name_enc, last_name_enc FROM identity.users WHERE id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Client introuvable.");
    const context = (column: string): string => fieldContext("identity", "users", column, userId);
    const firstName = row.first_name_enc === null ? null : await this.deps.encryptor.decrypt(row.first_name_enc, context("first_name"));
    const lastName = row.last_name_enc === null ? null : await this.deps.encryptor.decrypt(row.last_name_enc, context("last_name"));
    if (firstName === null || lastName === null) {
      throw new ForbiddenError("Vérifiez votre identité avant d'envoyer de l'argent.", { reason: "identity_not_declared" });
    }
    return {
      phoneE164: await this.deps.encryptor.decrypt(row.phone_enc, context("phone")),
      email: row.email_enc === null ? null : await this.deps.encryptor.decrypt(row.email_enc, context("email")),
      fullName: `${firstName} ${lastName}`,
    };
  }

  private async findByIdempotencyKey(userId: string, key: string): Promise<{ readonly id: string; readonly quote_id: string; readonly recipient_id: string } | null> {
    const result = await this.deps.pool.query<{ id: string; quote_id: string; recipient_id: string }>(
      "SELECT id, quote_id, recipient_id FROM transfers.transfers WHERE user_id = $1 AND idempotency_key = $2",
      [userId, key],
    );
    return result.rows[0] ?? null;
  }

  private async loadOwned(userId: string, transferId: string): Promise<ViewRow> {
    const result = await this.deps.pool.query<ViewRow>(
      `SELECT ${TRANSFER_COLUMNS}, r.display_hint
         FROM transfers.transfers t JOIN transfers.recipients r ON r.id = t.recipient_id
        WHERE t.id = $1 AND t.user_id = $2`,
      [transferId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Transfert introuvable.");
    return row;
  }

  private async view(transferId: string): Promise<TransferView> {
    const result = await this.deps.pool.query<ViewRow>(
      `SELECT ${TRANSFER_COLUMNS}, r.display_hint
         FROM transfers.transfers t JOIN transfers.recipients r ON r.id = t.recipient_id
        WHERE t.id = $1`,
      [transferId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError("Transfert introuvable.");
    return present(row);
  }

  private async loadAttempt(attemptId: string): Promise<AttemptRow> {
    const result = await this.deps.pool.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.id = $1`, [attemptId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("tentative introuvable");
    return row;
  }

  private async emit(client: TransactionClient, transferId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
       VALUES ('transfer', $1, $2, $3::jsonb, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [transferId, eventType, JSON.stringify({ transfer_id: transferId, ...payload }), `${eventType}:${transferId}`],
    );
  }
}

interface PayerProfile {
  readonly phoneE164: string;
  readonly email: string | null;
  readonly fullName: string;
}

function present(row: ViewRow): TransferView {
  const source = parseCurrencyCode(row.source_currency);
  const destination = parseCurrencyCode(row.destination_currency);
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    statusReason: row.status_reason,
    recipient: { id: row.recipient_id, displayHint: row.display_hint },
    sendAmount: Money.ofMinor(row.source_amount, source).toJSON(),
    fee: Money.ofMinor(row.fee_amount, source).toJSON(),
    totalToPay: Money.ofMinor(row.total_debit, source).toJSON(),
    receiveAmount: Money.ofMinor(row.destination_amount, destination).toJSON(),
    exchangeRate: row.customer_rate.includes(".") ? row.customer_rate.replace(/0+$/, "").replace(/\.$/, "") : row.customer_rate,
    fundingMethod: row.funding_method,
    payoutMethod: row.payout_method,
    purposeCode: row.purpose_code,
    createdAt: row.created_at.toISOString(),
    fundedAt: row.funded_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    refundedAt: row.refunded_at?.toISOString() ?? null,
  };
}
