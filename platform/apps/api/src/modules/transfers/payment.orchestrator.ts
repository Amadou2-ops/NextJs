import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import type { Actor, Queryable, TransactionClient } from "../../db/transaction.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { Money, parseCurrencyCode } from "../../lib/money.js";
import type { ComplianceService } from "../aml/compliance.service.js";
import type { LedgerService, Posting } from "../ledger/ledger.service.js";
import type { CircuitBreaker } from "../payments/circuitBreaker.js";
import { PaymentProviderError, statusOf } from "../payments/providers/types.js";
import type { PayinProvider, PaymentProviderName, PayoutProvider, ProviderAmount, ProviderStatus } from "../payments/providers/types.js";
import { availableFloat, lockFloat, payoutRoutes } from "../payments/routing.js";
import type { RecipientService } from "../recipients/recipients.service.js";
import { ACTIVE_ATTEMPT_STATUSES, ATTEMPT_COLUMNS, TRANSFER_COLUMNS } from "./transfer.types.js";
import type { AttemptRow, StoredAttemptStatus, TransferRow, TransferStatus } from "./transfer.types.js";

/**
 * Orchestration financière d'un transfert, du financement au paiement du
 * bénéficiaire ou au remboursement.
 *
 * Comptabilité (une écriture par étape, clé d'idempotence déterministe) :
 *   financement   portefeuille → réservation           transfer:<id>:funding  (transfer_hold)
 *                 ou trésorerie prestataire → réservation
 *   paiement      réservation → frais + position de change (devise source),
 *                 position de change → compensation sortante (devise cible)
 *                                                       transfer:<id>:payout:<tentative>
 *   règlement     compensation sortante → trésorerie prestataire
 *                                                       transfer:<id>:payout_settlement:<tentative>
 *   échec         contre-passation du journal de paiement (réservation rétablie)
 *   remboursement réservation → portefeuille ou trésorerie prestataire
 *                                                       transfer:<id>:refund
 * La base refuse toute transition de statut non adossée à ces écritures
 * (migration 0021).
 *
 * Appels prestataires : jamais dans une transaction ; toujours précédés de
 * l'enregistrement de la tentative et suivis de l'application du résultat
 * sous verrou. Une issue incertaine (réponse perdue) n'est jamais rejouée
 * vers une autre route : elle est réconciliée chez le prestataire.
 */

export type DispatchResult = "dispatched" | "completed" | "waiting" | "refunding" | "ignored";

export interface OrchestratorOptions {
  readonly payoutMaxRoutes: number;
}

export class PaymentOrchestrator {
  private readonly minorUnits = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly logger: Logger;
      readonly ledger: LedgerService;
      readonly recipients: RecipientService;
      readonly encryptor: FieldEncryptor;
      readonly breaker: CircuitBreaker;
      readonly compliance: ComplianceService;
      readonly payinProviders: ReadonlyMap<PaymentProviderName, PayinProvider>;
      readonly payoutProviders: ReadonlyMap<PaymentProviderName, PayoutProvider>;
      readonly options: OrchestratorOptions;
    },
  ) {}

  // ===========================================================================
  // Encaissement
  // ===========================================================================

  /** Applique l'état d'un encaissement lu chez le prestataire. */
  async refreshPayin(attemptId: string): Promise<void> {
    const attempt = await this.loadAttempt(this.deps.pool, attemptId);
    if (attempt.direction !== "payin") throw new Error("tentative d'encaissement attendue");
    if (attempt.status === "failed" || (attempt.status === "succeeded" && attempt.ledger_journal_id !== null)) return;
    const provider = this.payinProvider(attempt.provider);
    const units = await this.units(attempt.currency);

    let status: ProviderStatus;
    try {
      status = await this.deps.breaker.run(attempt.provider, () =>
        provider.getPayin({ providerReference: attempt.provider_reference, idempotencyKey: attempt.idempotency_key, minorUnits: units }),
      );
    } catch (error: unknown) {
      await this.noteCheck(attempt.id, error);
      throw error;
    }
    await this.applyPayinStatus(attempt.id, status);
  }

  async applyPayinStatus(attemptId: string, status: ProviderStatus): Promise<void> {
    const funded = await withTransaction(this.deps.pool, { actor: { type: "provider", id: "payments" } }, async (client) => {
      const attempt = await this.lockAttempt(client, attemptId);
      const transfer = await this.lockTransfer(client, attempt.transfer_id);
      const actor = `provider:${attempt.provider}`;

      if (status.status === "succeeded") {
        if (!this.sameAmount(status.amount, attempt)) {
          await this.alert(client, "payments.payin_amount_mismatch", attempt.id, `payin-mismatch:${attempt.id}`, {
            transfer_id: transfer.id,
            expected: attempt.amount.toString(),
            received: status.amount?.amountMinor.toString() ?? null,
            received_currency: status.amount?.currency ?? null,
          });
          return false;
        }
        if (transfer.status === "cancelled") {
          // Paiement arrivé après annulation : isolé en compte d'attente, à rembourser par l'exploitation.
          await this.deps.ledger.post(client, {
            idempotencyKey: `transfer:${transfer.id}:late_payin:${attempt.id}`,
            journalType: "adjustment",
            postings: [
              this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, attempt.currency), "debit", attempt.amount, attempt.currency),
              this.posting(await this.deps.ledger.systemAccount(client, "suspense", attempt.currency), "credit", attempt.amount, attempt.currency),
            ],
            description: `Encaissement tardif sur le transfert annulé ${transfer.reference}`,
            actor,
            reference: { type: "transfer", id: transfer.id },
          });
          await this.mergeResponse(client, attempt.id, { ...status.summary, late_payment: true });
          await this.alert(client, "payments.late_payin", attempt.id, `late-payin:${attempt.id}`, { transfer_id: transfer.id, provider: attempt.provider });
          return false;
        }
        if (attempt.status !== "succeeded") await this.setAttempt(client, attempt, "succeeded", status);
        if (transfer.status === "created") await this.transition(client, transfer.id, "awaiting_funding", null);
        if (transfer.status === "created" || transfer.status === "awaiting_funding") await this.transition(client, transfer.id, "funding_processing", null);
        if (transfer.status === "created" || transfer.status === "awaiting_funding" || transfer.status === "funding_processing") {
          await this.deps.ledger.post(client, {
            idempotencyKey: `transfer:${transfer.id}:funding`,
            journalType: "transfer_hold",
            postings: [
              this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, transfer.source_currency), "debit", transfer.total_debit, transfer.source_currency),
              this.posting(await this.deps.ledger.customerAccount(client, transfer.user_id, "customer_hold", transfer.source_currency), "credit", transfer.total_debit, transfer.source_currency),
            ],
            description: `Encaissement du transfert ${transfer.reference}`,
            actor,
            reference: { type: "transfer", id: transfer.id },
            metadata: { attempt_id: attempt.id, provider: attempt.provider },
          });
          await client.query("UPDATE payments.attempts SET ledger_journal_id = (SELECT id FROM ledger.journals WHERE idempotency_key = $2) WHERE id = $1 AND ledger_journal_id IS NULL", [
            attempt.id,
            `transfer:${transfer.id}:funding`,
          ]);
          await this.transition(client, transfer.id, "funded", null);
          await this.emit(client, transfer.id, "transfers.funded", { provider: attempt.provider });
          // Évaluation AML avant tout paiement : payout_pending ou compliance_review.
          await this.deps.compliance.evaluateAndRoute(client, transfer.id);
          if (status.fee !== null) {
            await this.deps.ledger.post(client, {
              idempotencyKey: `transfer:${transfer.id}:payin_fee:${attempt.id}`,
              journalType: "provider_fee",
              postings: [
                this.posting(await this.providerAccount(client, "provider_fee_expense", attempt.provider, status.fee.currency), "debit", status.fee.amountMinor, status.fee.currency),
                this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, status.fee.currency), "credit", status.fee.amountMinor, status.fee.currency),
              ],
              description: `Frais d'encaissement ${attempt.provider} — ${transfer.reference}`,
              actor,
              reference: { type: "transfer", id: transfer.id },
            });
          }
          return true;
        }
        return false;
      }

      if (status.status === "processing") {
        if (attempt.status === "pending" || attempt.status === "requires_action") await this.setAttempt(client, attempt, "processing", status);
        if (transfer.status === "awaiting_funding") await this.transition(client, transfer.id, "funding_processing", null);
        return false;
      }
      if (status.status === "requires_action" || status.status === "pending") {
        if (attempt.status === "pending" && status.status === "requires_action") await this.setAttempt(client, attempt, "requires_action", status);
        else await this.mergeResponse(client, attempt.id, status.summary);
        return false;
      }
      // Échec ou annulation de l'encaissement : le transfert est annulé.
      if (ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        const final: StoredAttemptStatus = status.status === "cancelled" && attempt.status !== "processing" ? "cancelled" : "failed";
        await this.setAttempt(client, attempt, final, status);
      }
      if (transfer.status === "created" || transfer.status === "awaiting_funding" || transfer.status === "funding_processing") {
        await this.transition(client, transfer.id, "cancelled", status.status === "cancelled" ? "funding_cancelled" : "funding_failed");
        await this.emit(client, transfer.id, "transfers.cancelled", { reason: status.failureCode ?? status.status });
      }
      return false;
    });
    if (funded) await this.dispatchPayoutSafely(status.providerReference ?? attemptId, await this.transferOfAttempt(attemptId));
  }

  /** Annule un financement non abouti (expiration ou demande du client). */
  async cancelFunding(transferId: string, reason: "funding_expired" | "cancelled_by_customer", actor: Actor): Promise<"cancelled" | "funded" | "processing"> {
    const attempt = await this.activeAttempt(this.deps.pool, transferId, "payin");
    if (attempt !== null) {
      // État à jour avant toute annulation : un paiement abouti n'est jamais annulé.
      await this.refreshPayin(attempt.id);
      const refreshed = await this.loadAttempt(this.deps.pool, attempt.id);
      if (refreshed.status === "succeeded") return "funded";
      if (refreshed.status === "processing") return "processing";
      if (ACTIVE_ATTEMPT_STATUSES.has(refreshed.status)) {
        const provider = this.payinProvider(refreshed.provider);
        await this.deps.breaker.run(refreshed.provider, () =>
          provider.cancelPayin({ providerReference: refreshed.provider_reference, idempotencyKey: refreshed.idempotency_key }),
        );
      }
    }
    return withTransaction(this.deps.pool, { actor }, async (client) => {
      const transfer = await this.lockTransfer(client, transferId);
      const current = attempt === null ? null : await this.lockAttempt(client, attempt.id);
      if (current?.status === "succeeded") return "funded";
      if (current !== null && (current.status === "pending" || current.status === "requires_action")) {
        await this.setAttempt(client, current, "cancelled", statusOf("cancelled", { failureCode: reason }));
      }
      if (transfer.status === "created" || transfer.status === "awaiting_funding") {
        await this.transition(client, transferId, "cancelled", reason);
        await this.emit(client, transferId, "transfers.cancelled", { reason });
        return "cancelled";
      }
      return transfer.status === "funding_processing" ? "processing" : "funded";
    });
  }

  // ===========================================================================
  // Paiement sortant
  // ===========================================================================

  async dispatchPayout(transferId: string): Promise<DispatchResult> {
    for (let round = 0; round <= this.deps.options.payoutMaxRoutes; round += 1) {
      const plan = await this.preparePayout(transferId);
      if (plan.kind !== "ready") return plan.kind;
      const outcome = await this.executePayout(plan.attemptId);
      if (outcome !== "retry") return outcome;
    }
    return "waiting";
  }

  private async dispatchPayoutSafely(context: string, transferId: string): Promise<void> {
    try {
      await this.dispatchPayout(transferId);
    } catch (error: unknown) {
      // Le worker reprendra le transfert (statut payout_pending).
      this.deps.logger.error({ err: error, transferId, context }, "paiement sortant non déclenché");
    }
  }

  private async preparePayout(transferId: string): Promise<{ readonly kind: "ready"; readonly attemptId: string } | { readonly kind: "waiting" | "refunding" | "ignored" }> {
    const transfer = await this.loadTransfer(this.deps.pool, transferId);
    if (transfer.status !== "payout_pending") return { kind: "ignored" };
    const previous = await this.deps.pool.query<{ corridor_id: string; status: StoredAttemptStatus }>(
      "SELECT corridor_id, status FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout'",
      [transferId],
    );
    if (previous.rows.some((row) => ACTIVE_ATTEMPT_STATUSES.has(row.status) || row.status === "succeeded")) return { kind: "ignored" };
    if (previous.rows.length >= this.deps.options.payoutMaxRoutes) {
      await this.moveToRefund(transferId, "payout_routes_exhausted");
      return { kind: "refunding" };
    }

    const routes = (
      await payoutRoutes(this.deps.pool, {
        sourceCountry: transfer.source_country,
        destinationCountry: transfer.destination_country,
        currency: transfer.destination_currency,
        payoutMethod: transfer.payout_method,
        amountMinor: transfer.destination_amount,
        excludedCorridorIds: previous.rows.map((row) => row.corridor_id),
      })
    ).filter((route) => this.deps.payoutProviders.get(route.provider)?.supports(transfer.payout_method) === true);
    if (routes.length === 0) {
      await this.moveToRefund(transferId, previous.rows.length === 0 ? "no_payout_route" : "payout_routes_exhausted");
      return { kind: "refunding" };
    }

    for (const route of routes) {
      if (!(await this.deps.breaker.canUse(route.provider))) continue;
      const attemptId = await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, async (client) => {
        const locked = await this.lockTransfer(client, transferId);
        if (locked.status !== "payout_pending") return null;
        const active = await client.query("SELECT 1 FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout' AND status IN ('pending', 'requires_action', 'processing', 'succeeded')", [transferId]);
        if (active.rowCount !== 0) return null;

        await lockFloat(client, route.provider, locked.destination_currency);
        const float = await availableFloat(client, route.provider, locked.destination_currency);
        if (float < locked.destination_amount) {
          await this.alert(client, "payments.float_insufficient", transferId, `float:${route.provider}:${locked.destination_currency}:${new Date().toISOString().slice(0, 13)}`, {
            provider: route.provider,
            currency: locked.destination_currency,
            available: float.toString(),
            required: locked.destination_amount.toString(),
          });
          return null;
        }

        const id = randomUUID();
        await client.query(
          `INSERT INTO payments.attempts (id, transfer_id, direction, provider, corridor_id, idempotency_key, amount, currency, provider_response)
           VALUES ($1, $2, 'payout', $3::payments.provider, $4, $5, $6, $7, $8::jsonb)`,
          [id, transferId, route.provider, route.id, `po-${id}`, locked.destination_amount.toString(), locked.destination_currency, JSON.stringify({ route_code: route.routeCode })],
        );
        const journalId = await this.deps.ledger.post(client, {
          idempotencyKey: `transfer:${transferId}:payout:${id}`,
          journalType: "transfer_payout",
          postings: await this.payoutPostings(client, locked, route.provider),
          description: `Paiement sortant ${route.provider} — ${locked.reference}`,
          actor: "system:payments",
          reference: { type: "transfer", id: transferId },
          metadata: { attempt_id: id, corridor_id: route.id },
        });
        await client.query("UPDATE payments.attempts SET ledger_journal_id = $2 WHERE id = $1", [id, journalId]);
        await this.transition(client, transferId, "payout_processing", null);
        return id;
      });
      if (attemptId !== null) return { kind: "ready", attemptId };
    }

    await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, (client) =>
      this.alert(client, "payments.payout_waiting", transferId, `payout-waiting:${transferId}`, { reason: "providers_unavailable_or_float_insufficient" }),
    );
    return { kind: "waiting" };
  }

  private async payoutPostings(client: TransactionClient, transfer: TransferRow, provider: PaymentProviderName): Promise<Posting[]> {
    const source = transfer.source_currency;
    const destination = transfer.destination_currency;
    const postings: Posting[] = [
      this.posting(await this.deps.ledger.customerAccount(client, transfer.user_id, "customer_hold", source), "debit", transfer.total_debit, source),
    ];
    if (transfer.fee_amount > 0n) {
      postings.push(this.posting(await this.deps.ledger.systemAccount(client, "fee_revenue", source), "credit", transfer.fee_amount, source));
    }
    const clearing = await this.providerAccount(client, "payout_clearing", provider, destination);
    if (source === destination) {
      postings.push(this.posting(clearing, "credit", transfer.source_amount, source));
    } else {
      postings.push(this.posting(await this.deps.ledger.systemAccount(client, "fx_position", source), "credit", transfer.source_amount, source));
      postings.push(this.posting(await this.deps.ledger.systemAccount(client, "fx_position", destination), "debit", transfer.destination_amount, destination));
      postings.push(this.posting(clearing, "credit", transfer.destination_amount, destination));
    }
    return postings;
  }

  private async executePayout(attemptId: string): Promise<DispatchResult | "retry"> {
    const attempt = await this.loadAttempt(this.deps.pool, attemptId);
    const provider = this.payoutProvider(attempt.provider);
    let status: ProviderStatus;
    try {
      const request = await this.payoutRequest(attempt);
      status = await this.deps.breaker.run(attempt.provider, () => provider.createPayout(request));
    } catch (error: unknown) {
      if (error instanceof PaymentProviderError && !error.retryable && !error.outcomeUnknown) {
        status = statusOf("failed", { failureCode: error.providerCode ?? "rejected", failureMessage: error.message.slice(0, 200) });
      } else {
        await this.markUncertain(attempt, error);
        return "waiting";
      }
    }
    return this.applyPayoutStatus(attempt.id, status);
  }

  /** Relit un paiement sortant chez le prestataire et applique son état. */
  async refreshPayout(attemptId: string): Promise<void> {
    const attempt = await this.loadAttempt(this.deps.pool, attemptId);
    if (attempt.direction !== "payout") throw new Error("tentative de paiement sortant attendue");
    if (attempt.status === "failed" || attempt.status === "cancelled" || attempt.status === "reversed") return;
    const provider = this.payoutProvider(attempt.provider);
    const stage = attempt.provider_response["stage"];
    // Ordre refusé avant exécution (limitation de débit) : nouvel envoi avec la même clé.
    if (attempt.status === "pending" && attempt.provider_reference === null && stage === "create_retry") {
      const outcome = await this.executePayout(attempt.id);
      if (outcome === "retry") await this.dispatchPayout(attempt.transfer_id);
      return;
    }
    let status: ProviderStatus;
    try {
      status = await this.deps.breaker.run(attempt.provider, async () =>
        provider.getPayout({ providerReference: attempt.provider_reference, idempotencyKey: attempt.idempotency_key, minorUnits: await this.units(attempt.currency) }),
      );
    } catch (error: unknown) {
      await this.noteCheck(attempt.id, error);
      throw error;
    }
    const outcome = await this.applyPayoutStatus(attempt.id, status);
    if (outcome === "retry") await this.dispatchPayout(attempt.transfer_id);
  }

  async applyPayoutStatus(attemptId: string, status: ProviderStatus): Promise<DispatchResult | "retry"> {
    const result = await withTransaction(this.deps.pool, { actor: { type: "provider", id: "payments" } }, async (client) => {
      const attempt = await this.lockAttempt(client, attemptId);
      const transfer = await this.lockTransfer(client, attempt.transfer_id);
      const actor = `provider:${attempt.provider}`;

      if (status.status === "reversed") {
        if (attempt.status === "succeeded") {
          await this.setAttempt(client, attempt, "reversed", status);
          await this.alert(client, "payments.payout_reversed_after_completion", attempt.id, `payout-reversed:${attempt.id}`, { transfer_id: transfer.id, provider: attempt.provider });
          return "completed";
        }
      }
      if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled" || attempt.status === "reversed") return "ignored";

      if (status.status === "succeeded") {
        if (!this.sameAmount(status.amount, attempt)) {
          await this.alert(client, "payments.payout_amount_mismatch", attempt.id, `payout-mismatch:${attempt.id}`, {
            transfer_id: transfer.id,
            expected: attempt.amount.toString(),
            reported: status.amount?.amountMinor.toString() ?? null,
          });
          return "waiting";
        }
        await this.setAttempt(client, attempt, "succeeded", status);
        await this.deps.ledger.post(client, {
          idempotencyKey: `transfer:${transfer.id}:payout_settlement:${attempt.id}`,
          journalType: "payout_settlement",
          postings: [
            this.posting(await this.providerAccount(client, "payout_clearing", attempt.provider, attempt.currency), "debit", attempt.amount, attempt.currency),
            this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, attempt.currency), "credit", attempt.amount, attempt.currency),
          ],
          description: `Règlement du paiement sortant ${transfer.reference}`,
          actor,
          reference: { type: "transfer", id: transfer.id },
          metadata: { attempt_id: attempt.id },
        });
        await this.transition(client, transfer.id, "completed", null);
        await this.emit(client, transfer.id, "transfers.completed", { provider: attempt.provider });
        return "completed";
      }

      if (status.status === "processing" || status.status === "pending" || status.status === "requires_action") {
        if (attempt.status === "pending" && status.status !== "pending") await this.setAttempt(client, attempt, status.status, status);
        else await this.mergeResponse(client, attempt.id, { ...status.summary, stage: "submitted" }, status.providerReference);
        return "dispatched";
      }

      // Échec : la réservation est rétablie par contre-passation, puis nouvelle route ou remboursement.
      await this.setAttempt(client, attempt, "failed", status.failureCode === null ? { ...status, failureCode: "payout_failed" } : status);
      if (attempt.ledger_journal_id !== null) {
        await this.deps.ledger.reverse(client, {
          journalId: attempt.ledger_journal_id,
          idempotencyKey: `transfer:${transfer.id}:payout_reversal:${attempt.id}`,
          reason: `Échec du paiement sortant ${attempt.provider} (${status.failureCode ?? status.status})`,
          actor,
        });
      }
      if (transfer.status === "payout_processing") await this.transition(client, transfer.id, "payout_failed", status.failureCode ?? "payout_failed");
      const attempts = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout'", [transfer.id]);
      if (Number(attempts.rows[0]?.count ?? "0") < this.deps.options.payoutMaxRoutes) {
        await this.transition(client, transfer.id, "payout_pending", "retry_other_route");
        return "retry";
      }
      await this.transition(client, transfer.id, "refund_pending", "payout_routes_exhausted");
      await this.emit(client, transfer.id, "transfers.refund_started", { reason: "payout_routes_exhausted" });
      return "refunding";
    });

    if (status.status === "succeeded" && status.fee !== null && result === "completed") await this.recordPayoutFee(attemptId, status.fee);
    if (result === "refunding") await this.startRefund(await this.transferOfAttempt(attemptId));
    return result;
  }

  private async recordPayoutFee(attemptId: string, fee: ProviderAmount): Promise<void> {
    try {
      await withTransaction(this.deps.pool, { actor: { type: "provider", id: "payments" } }, async (client) => {
        const attempt = await this.loadAttempt(client, attemptId);
        await this.deps.ledger.post(client, {
          idempotencyKey: `transfer:${attempt.transfer_id}:payout_fee:${attempt.id}`,
          journalType: "provider_fee",
          postings: [
            this.posting(await this.providerAccount(client, "provider_fee_expense", attempt.provider, fee.currency), "debit", fee.amountMinor, fee.currency),
            this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, fee.currency), "credit", fee.amountMinor, fee.currency),
          ],
          description: `Frais de paiement sortant ${attempt.provider}`,
          actor: `provider:${attempt.provider}`,
          reference: { type: "transfer", id: attempt.transfer_id },
        });
      });
    } catch (error: unknown) {
      // Trésorerie insuffisante pour constater les frais : écart de rapprochement à traiter.
      this.deps.logger.error({ err: error, attemptId }, "frais prestataire non comptabilisés");
      await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, (client) =>
        this.alert(client, "payments.fee_not_recorded", attemptId, `fee-not-recorded:${attemptId}`, { amount: fee.amountMinor.toString(), currency: fee.currency }),
      );
    }
  }

  private async payoutRequest(attempt: AttemptRow): Promise<Parameters<PayoutProvider["createPayout"]>[0]> {
    const transfer = await this.loadTransfer(this.deps.pool, attempt.transfer_id);
    const recipient = await this.deps.recipients.forPayout(this.deps.pool, transfer.recipient_id);
    const sender = await this.deps.pool.query<{
      first_name_enc: Buffer | null;
      last_name_enc: Buffer | null;
      date_of_birth_enc: Buffer | null;
      residence_alpha3: string;
      nationality_alpha3: string | null;
      source_alpha3: string;
      destination_alpha3: string;
    }>(
      `SELECT u.first_name_enc, u.last_name_enc, u.date_of_birth_enc, r.alpha3 AS residence_alpha3, n.alpha3 AS nationality_alpha3,
              s.alpha3 AS source_alpha3, d.alpha3 AS destination_alpha3
         FROM identity.users u
         JOIN ref.countries r ON r.alpha2 = u.country_of_residence
         LEFT JOIN ref.countries n ON n.alpha2 = u.nationality
         JOIN ref.countries s ON s.alpha2 = $2
         JOIN ref.countries d ON d.alpha2 = $3
        WHERE u.id = $1`,
      [transfer.user_id, transfer.source_country, transfer.destination_country],
    );
    const row = sender.rows[0];
    if (row?.first_name_enc === null || row?.first_name_enc === undefined || row.last_name_enc === null) {
      throw new PaymentProviderError(attempt.provider, "identité de l'expéditeur indisponible", false, false, "sender_identity_missing");
    }
    const context = (column: string): string => fieldContext("identity", "users", column, transfer.user_id);
    const corridor = await this.deps.pool.query<{ provider_route_code: string | null }>("SELECT provider_route_code FROM payments.payout_corridors WHERE id = $1", [attempt.corridor_id]);
    return {
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotency_key,
      transferReference: transfer.reference,
      amountMinor: attempt.amount,
      currency: attempt.currency,
      minorUnits: await this.units(attempt.currency),
      sourceCountryAlpha3: row.source_alpha3,
      destinationCountry: transfer.destination_country,
      destinationCountryAlpha3: row.destination_alpha3,
      payoutMethod: transfer.payout_method,
      routeCode: corridor.rows[0]?.provider_route_code ?? null,
      purposeCode: transfer.purpose_code,
      recipient: { firstName: recipient.firstName, lastName: recipient.lastName, account: recipient.account },
      sender: {
        firstName: await this.deps.encryptor.decrypt(row.first_name_enc, context("first_name")),
        lastName: await this.deps.encryptor.decrypt(row.last_name_enc, context("last_name")),
        dateOfBirth: row.date_of_birth_enc === null ? null : await this.deps.encryptor.decrypt(row.date_of_birth_enc, context("date_of_birth")),
        countryAlpha3: row.residence_alpha3,
        nationalityAlpha3: row.nationality_alpha3,
      },
    };
  }

  private async markUncertain(attempt: AttemptRow, error: unknown): Promise<void> {
    const unknown = error instanceof PaymentProviderError && error.outcomeUnknown;
    await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, async (client) => {
      await this.mergeResponse(client, attempt.id, {
        stage: unknown ? "outcome_unknown" : "create_retry",
        last_error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      if (unknown) {
        await this.alert(client, "payments.outcome_unknown", attempt.id, `outcome-unknown:${attempt.id}`, {
          transfer_id: attempt.transfer_id,
          provider: attempt.provider,
          direction: attempt.direction,
        });
      }
    });
    this.deps.logger.warn({ err: error, attemptId: attempt.id, provider: attempt.provider }, unknown ? "issue de paiement incertaine : réconciliation" : "ordre de paiement à renvoyer");
  }

  // ===========================================================================
  // Remboursement
  // ===========================================================================

  private async moveToRefund(transferId: string, reason: string): Promise<void> {
    const moved = await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, async (client) => {
      const transfer = await this.lockTransfer(client, transferId);
      if (transfer.status !== "payout_pending" && transfer.status !== "funded" && transfer.status !== "payout_failed") return false;
      await this.transition(client, transferId, "refund_pending", reason);
      await this.emit(client, transferId, "transfers.refund_started", { reason });
      return true;
    });
    if (moved) await this.startRefund(transferId);
  }

  /** Demande d'annulation d'un transfert financé mais pas encore payé. */
  async refundBeforePayout(transferId: string, actor: Actor): Promise<boolean> {
    const moved = await withTransaction(this.deps.pool, { actor }, async (client) => {
      const transfer = await this.lockTransfer(client, transferId);
      if (transfer.status !== "funded" && transfer.status !== "payout_pending") return false;
      const active = await client.query("SELECT 1 FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout' AND status IN ('pending', 'requires_action', 'processing', 'succeeded')", [transferId]);
      if (active.rowCount !== 0) return false;
      await this.transition(client, transferId, "refund_pending", "cancelled_by_customer");
      await this.emit(client, transferId, "transfers.refund_started", { reason: "cancelled_by_customer" });
      return true;
    });
    if (moved) await this.startRefund(transferId);
    return moved;
  }

  // ---------------------------------------------------------------------------
  // Décisions de conformité (back-office). L'acteur est le membre du personnel ;
  // la base vérifie sa permission et, pour le remboursement, la double
  // validation (migration 0023).
  // ---------------------------------------------------------------------------

  /** Met en revue un transfert financé et pas encore parti, avec une alerte manuelle. */
  async holdForReview(transferId: string, actor: Actor, reason: string, audit: (client: TransactionClient) => Promise<void>): Promise<"held" | "not_holdable"> {
    return withTransaction(this.deps.pool, { actor, changeNote: reason }, async (client) => {
      const transfer = await this.lockTransfer(client, transferId);
      if (transfer.status !== "funded" && transfer.status !== "payout_pending") return "not_holdable";
      const active = await client.query("SELECT 1 FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout' AND status IN ('pending', 'requires_action', 'processing', 'succeeded')", [transferId]);
      if (active.rowCount !== 0) return "not_holdable";
      await client.query(
        `INSERT INTO aml.alerts (user_id, transfer_id, rule_code, severity, score, details, assigned_to_admin_id, status)
         VALUES ($1, $2, 'MANUAL_REVIEW', 'high', 80, $3::jsonb, $4, 'under_review')`,
        [transfer.user_id, transferId, JSON.stringify({ reason }), actor.id],
      );
      await this.transition(client, transferId, "compliance_review", "manual_review");
      await this.emit(client, transferId, "transfers.held_for_review", { reason });
      await audit(client);
      return "held";
    });
  }

  /** Libère un transfert en revue (alertes bloquantes levées) puis lance le paiement sortant. */
  async releaseFromReview(transferId: string, actor: Actor, note: string, audit: (client: TransactionClient) => Promise<void>): Promise<"released" | "not_in_review"> {
    const released = await withTransaction(this.deps.pool, { actor, changeNote: note }, async (client) => {
      const transfer = await this.lockTransfer(client, transferId);
      if (transfer.status !== "compliance_review") return false;
      await this.transition(client, transferId, "payout_pending", "compliance_released");
      await this.emit(client, transferId, "transfers.compliance_released", {});
      await audit(client);
      return true;
    });
    if (!released) return "not_in_review";
    await this.dispatchPayoutSafely("compliance_release", transferId);
    return "released";
  }

  /**
   * Remboursement ordonné par la conformité, dans la transaction qui exécute
   * la demande approuvée. Le remboursement lui-même est lancé après validation
   * (startRefund), hors transaction.
   */
  async orderRefundInTransaction(client: TransactionClient, transferId: string, reason: string): Promise<"refund_pending" | "not_refundable"> {
    const transfer = await this.lockTransfer(client, transferId);
    if (!["funded", "payout_pending", "compliance_review", "payout_failed"].includes(transfer.status)) return "not_refundable";
    const active = await client.query("SELECT 1 FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout' AND status IN ('pending', 'requires_action', 'processing', 'succeeded')", [transferId]);
    if (active.rowCount !== 0) return "not_refundable";
    await this.transition(client, transferId, "refund_pending", "compliance_refund");
    await this.emit(client, transferId, "transfers.refund_started", { reason: "compliance_refund", note: reason });
    return "refund_pending";
  }

  async startRefund(transferId: string): Promise<void> {
    const transfer = await this.loadTransfer(this.deps.pool, transferId);
    if (transfer.status !== "refund_pending") return;
    const payin = await this.deps.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.transfer_id = $1 AND a.direction = 'payin' AND a.status = 'succeeded'`,
      [transferId],
    );
    const succeededPayin = payin.rows[0];

    if (succeededPayin === undefined) {
      // Financé par le portefeuille : la réservation y retourne.
      await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, async (client) => {
        const locked = await this.lockTransfer(client, transferId);
        if (locked.status !== "refund_pending") return;
        await this.deps.ledger.post(client, {
          idempotencyKey: `transfer:${transferId}:refund`,
          journalType: "transfer_hold_release",
          postings: [
            this.posting(await this.deps.ledger.customerAccount(client, locked.user_id, "customer_hold", locked.source_currency), "debit", locked.total_debit, locked.source_currency),
            this.posting(await this.deps.ledger.customerAccount(client, locked.user_id, "customer_wallet", locked.source_currency), "credit", locked.total_debit, locked.source_currency),
          ],
          description: `Remboursement sur portefeuille — ${locked.reference}`,
          actor: "system:payments",
          reference: { type: "transfer", id: transferId },
        });
        await this.transition(client, transferId, "refunded", null);
        await this.emit(client, transferId, "transfers.refunded", { destination: "wallet" });
      });
      return;
    }

    const existing = await this.activeAttempt(this.deps.pool, transferId, "refund");
    if (existing !== null) return;
    const refundId = await withTransaction(this.deps.pool, { actor: { type: "system", id: "payments" } }, async (client) => {
      const locked = await this.lockTransfer(client, transferId);
      if (locked.status !== "refund_pending") return null;
      const id = randomUUID();
      await client.query(
        `INSERT INTO payments.attempts (id, transfer_id, direction, provider, payin_method_id, idempotency_key, amount, currency)
         VALUES ($1, $2, 'refund', $3::payments.provider, $4, $5, $6, $7)`,
        [id, transferId, succeededPayin.provider, succeededPayin.payin_method_id, `rf-${id}`, locked.total_debit.toString(), locked.source_currency],
      );
      return id;
    });
    if (refundId !== null) await this.executeRefund(refundId, succeededPayin);
  }

  private async executeRefund(refundAttemptId: string, payin: AttemptRow): Promise<void> {
    const attempt = await this.loadAttempt(this.deps.pool, refundAttemptId);
    const provider = this.payinProvider(attempt.provider);
    if (payin.provider_reference === null) throw new Error("encaissement réussi sans référence prestataire");
    const payinReference = payin.provider_reference;
    let status: ProviderStatus;
    try {
      status = await this.deps.breaker.run(attempt.provider, async () =>
        provider.createRefund({
          idempotencyKey: attempt.idempotency_key,
          payin: { providerReference: payinReference, summary: payin.provider_response },
          amountMinor: attempt.amount,
          currency: attempt.currency,
          minorUnits: await this.units(attempt.currency),
        }),
      );
    } catch (error: unknown) {
      if (error instanceof PaymentProviderError && !error.retryable && !error.outcomeUnknown) {
        status = statusOf("failed", { failureCode: error.providerCode ?? "refund_rejected", failureMessage: error.message.slice(0, 200) });
      } else {
        await this.markUncertain(attempt, error);
        return;
      }
    }
    await this.applyRefundStatus(attempt.id, status);
  }

  async refreshRefund(attemptId: string): Promise<void> {
    const attempt = await this.loadAttempt(this.deps.pool, attemptId);
    if (attempt.direction !== "refund") throw new Error("tentative de remboursement attendue");
    if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return;
    if (attempt.provider_reference === null) {
      // Ordre jamais confirmé : renvoi avec la même clé (idempotent chez Stripe) ou réconciliation.
      const stage = attempt.provider_response["stage"];
      if (stage === "create_retry" || (stage === "outcome_unknown" && attempt.provider === "stripe")) {
        const payin = await this.deps.pool.query<AttemptRow>(
          `SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.transfer_id = $1 AND a.direction = 'payin' AND a.status = 'succeeded'`,
          [attempt.transfer_id],
        );
        const succeeded = payin.rows[0];
        if (succeeded !== undefined) await this.executeRefund(attempt.id, succeeded);
      }
      return;
    }
    const provider = this.payinProvider(attempt.provider);
    const reference = attempt.provider_reference;
    const status = await this.deps.breaker.run(attempt.provider, async () =>
      provider.getRefund({ providerReference: reference, minorUnits: await this.units(attempt.currency) }),
    );
    await this.applyRefundStatus(attempt.id, status);
  }

  async applyRefundStatus(attemptId: string, status: ProviderStatus): Promise<void> {
    await withTransaction(this.deps.pool, { actor: { type: "provider", id: "payments" } }, async (client) => {
      const attempt = await this.lockAttempt(client, attemptId);
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return;
      const transfer = await this.lockTransfer(client, attempt.transfer_id);
      if (status.status === "succeeded") {
        if (status.amount !== null && !this.sameAmount(status.amount, attempt)) {
          await this.alert(client, "payments.refund_amount_mismatch", attempt.id, `refund-mismatch:${attempt.id}`, { transfer_id: transfer.id });
          return;
        }
        await this.setAttempt(client, attempt, "succeeded", status);
        await this.deps.ledger.post(client, {
          idempotencyKey: `transfer:${transfer.id}:refund`,
          journalType: "refund",
          postings: [
            this.posting(await this.deps.ledger.customerAccount(client, transfer.user_id, "customer_hold", transfer.source_currency), "debit", transfer.total_debit, transfer.source_currency),
            this.posting(await this.providerAccount(client, "provider_settlement", attempt.provider, transfer.source_currency), "credit", transfer.total_debit, transfer.source_currency),
          ],
          description: `Remboursement ${attempt.provider} — ${transfer.reference}`,
          actor: `provider:${attempt.provider}`,
          reference: { type: "transfer", id: transfer.id },
          metadata: { attempt_id: attempt.id },
        });
        await this.transition(client, transfer.id, "refunded", null);
        await this.emit(client, transfer.id, "transfers.refunded", { destination: "payment_source", provider: attempt.provider });
        return;
      }
      if (status.status === "processing" || status.status === "pending" || status.status === "requires_action") {
        if (attempt.status === "pending" && status.status !== "pending") await this.setAttempt(client, attempt, status.status, status);
        else await this.mergeResponse(client, attempt.id, status.summary, status.providerReference);
        return;
      }
      await this.setAttempt(client, attempt, "failed", status.failureCode === null ? { ...status, failureCode: "refund_failed" } : status);
      await this.alert(client, "payments.refund_failed", attempt.id, `refund-failed:${attempt.id}`, { transfer_id: transfer.id, provider: attempt.provider, code: status.failureCode });
    });
  }

  // ===========================================================================
  // Rétrofacturations (Stripe)
  // ===========================================================================

  async applyDispute(event: {
    readonly disputeId: string;
    readonly paymentIntentId: string;
    readonly kind: "funds_withdrawn" | "funds_reinstated";
    readonly amount: ProviderAmount;
  }): Promise<"processed" | "ignored"> {
    return withTransaction(this.deps.pool, { actor: { type: "provider", id: "stripe" } }, async (client) => {
      const attempt = await client.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.provider = 'stripe' AND a.direction = 'payin' AND a.provider_reference = $1`,
        [event.paymentIntentId],
      );
      const payin = attempt.rows[0];
      if (payin === undefined) return "ignored";
      const withdrawnKey = `dispute:${event.disputeId}:funds_withdrawn`;
      if (event.kind === "funds_withdrawn") {
        await this.deps.ledger.post(client, {
          idempotencyKey: withdrawnKey,
          journalType: "chargeback",
          postings: [
            this.posting(await this.deps.ledger.systemAccount(client, "chargeback_loss", event.amount.currency), "debit", event.amount.amountMinor, event.amount.currency),
            this.posting(await this.providerAccount(client, "provider_settlement", "stripe", event.amount.currency), "credit", event.amount.amountMinor, event.amount.currency),
          ],
          description: `Rétrofacturation ${event.disputeId}`,
          actor: "provider:stripe",
          reference: { type: "transfer", id: payin.transfer_id },
          metadata: { dispute_id: event.disputeId, payment_intent: event.paymentIntentId },
        });
      } else {
        const journal = await client.query<{ id: string }>("SELECT id FROM ledger.journals WHERE idempotency_key = $1", [withdrawnKey]);
        const withdrawn = journal.rows[0];
        if (withdrawn === undefined) return "ignored";
        await this.deps.ledger.reverse(client, {
          journalId: withdrawn.id,
          idempotencyKey: `dispute:${event.disputeId}:funds_reinstated`,
          reason: `Rétrofacturation ${event.disputeId} gagnée : fonds rétablis`,
          actor: "provider:stripe",
        });
      }
      await this.alert(client, `payments.dispute_${event.kind}`, payin.transfer_id, `dispute:${event.disputeId}:${event.kind}`, {
        dispute_id: event.disputeId,
        transfer_id: payin.transfer_id,
        amount: event.amount.amountMinor.toString(),
        currency: event.amount.currency,
      });
      return "processed";
    });
  }

  // ===========================================================================
  // Synchronisation (worker)
  // ===========================================================================

  async refreshAttempt(attemptId: string): Promise<void> {
    const attempt = await this.loadAttempt(this.deps.pool, attemptId);
    switch (attempt.direction) {
      case "payin":
        return this.refreshPayin(attemptId);
      case "payout":
        return this.refreshPayout(attemptId);
      case "refund":
        return this.refreshRefund(attemptId);
    }
  }

  async synchronize(params: { readonly limit: number; readonly fundingTtlMinutes: number }): Promise<{
    readonly refreshed: number;
    readonly failed: number;
    readonly expired: number;
    readonly dispatched: number;
    readonly refunds: number;
  }> {
    const counters = { refreshed: 0, failed: 0, expired: 0, dispatched: 0, refunds: 0 };
    const stale = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM payments.attempts
        WHERE status IN ('pending', 'requires_action', 'processing') AND updated_at < now() - interval '2 minutes'
        ORDER BY updated_at LIMIT $1`,
      [params.limit],
    );
    for (const { id } of stale.rows) {
      try {
        await this.refreshAttempt(id);
        counters.refreshed += 1;
      } catch (error: unknown) {
        counters.failed += 1;
        this.deps.logger.warn({ err: error, attemptId: id }, "synchronisation de paiement en échec");
      }
    }

    const expired = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM transfers.transfers
        WHERE status IN ('created', 'awaiting_funding') AND created_at < now() - make_interval(mins => $1)
        ORDER BY created_at LIMIT $2`,
      [params.fundingTtlMinutes, params.limit],
    );
    for (const { id } of expired.rows) {
      try {
        if ((await this.cancelFunding(id, "funding_expired", { type: "system", id: "payments" })) === "cancelled") counters.expired += 1;
      } catch (error: unknown) {
        counters.failed += 1;
        this.deps.logger.warn({ err: error, transferId: id }, "expiration du financement en échec");
      }
    }

    const pending = await this.deps.pool.query<{ id: string; status: TransferStatus }>(
      `SELECT t.id, t.status FROM transfers.transfers t
        WHERE t.status IN ('payout_pending', 'refund_pending') AND t.updated_at < now() - interval '30 seconds'
          AND NOT EXISTS (SELECT 1 FROM payments.attempts a
                           WHERE a.transfer_id = t.id AND a.status IN ('pending', 'requires_action', 'processing')
                             AND a.direction = CASE WHEN t.status = 'payout_pending' THEN 'payout'::payments.payment_direction
                                                    ELSE 'refund'::payments.payment_direction END)
        ORDER BY t.updated_at LIMIT $1`,
      [params.limit],
    );
    for (const row of pending.rows) {
      try {
        if (row.status === "payout_pending") {
          await this.dispatchPayout(row.id);
          counters.dispatched += 1;
        } else {
          await this.startRefund(row.id);
          counters.refunds += 1;
        }
      } catch (error: unknown) {
        counters.failed += 1;
        this.deps.logger.warn({ err: error, transferId: row.id }, "reprise de transfert en échec");
      }
    }
    return counters;
  }

  // ===========================================================================
  // Outils
  // ===========================================================================

  async findAttempt(where: { readonly provider: PaymentProviderName; readonly providerReference?: string; readonly idempotencyKey?: string }): Promise<AttemptRow | null> {
    const result =
      where.idempotencyKey !== undefined
        ? await this.deps.pool.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.provider = $1::payments.provider AND a.idempotency_key = $2`, [where.provider, where.idempotencyKey])
        : await this.deps.pool.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.provider = $1::payments.provider AND a.provider_reference = $2`, [where.provider, where.providerReference ?? ""]);
    return result.rows[0] ?? null;
  }

  async units(currency: string): Promise<number> {
    const cached = this.minorUnits.get(currency);
    if (cached !== undefined) return cached;
    const result = await this.deps.pool.query<{ minor_units: number }>("SELECT minor_units FROM ref.currencies WHERE code = $1", [currency]);
    const units = result.rows[0]?.minor_units;
    if (units === undefined) throw new Error(`devise inconnue : ${currency}`);
    this.minorUnits.set(currency, units);
    return units;
  }

  private payinProvider(name: PaymentProviderName): PayinProvider {
    const provider = this.deps.payinProviders.get(name);
    if (provider === undefined) throw new PaymentProviderError(name, "prestataire d'encaissement non configuré", false, false);
    return provider;
  }

  private payoutProvider(name: PaymentProviderName): PayoutProvider {
    const provider = this.deps.payoutProviders.get(name);
    if (provider === undefined) throw new PaymentProviderError(name, "prestataire de paiement sortant non configuré", false, false);
    return provider;
  }

  private sameAmount(amount: ProviderAmount | null, attempt: AttemptRow): boolean {
    return amount !== null && amount.amountMinor === attempt.amount && amount.currency.toUpperCase() === attempt.currency;
  }

  private posting(accountId: string, direction: "debit" | "credit", amountMinor: bigint, currency: string): Posting {
    return { accountId, direction, money: Money.ofMinor(amountMinor, parseCurrencyCode(currency)) };
  }

  private providerAccount(
    client: Queryable,
    type: "provider_settlement" | "payout_clearing" | "provider_fee_expense",
    provider: PaymentProviderName,
    currency: string,
  ): Promise<string> {
    return this.deps.ledger.systemAccount(client, type, currency, provider);
  }

  private async setAttempt(client: TransactionClient, attempt: AttemptRow, status: StoredAttemptStatus, providerStatus: ProviderStatus): Promise<void> {
    await client.query(
      `UPDATE payments.attempts
          SET status = $2::payments.attempt_status,
              provider_reference = COALESCE(provider_reference, $3),
              failure_code = CASE WHEN $2 IN ('failed', 'cancelled') THEN COALESCE($4, failure_code, $2::text) ELSE failure_code END,
              failure_message = COALESCE($5, failure_message),
              provider_response = provider_response || $6::jsonb
        WHERE id = $1`,
      [attempt.id, status, providerStatus.providerReference, providerStatus.failureCode, providerStatus.failureMessage, JSON.stringify({ ...providerStatus.summary, stage: "updated" })],
    );
  }

  private async mergeResponse(client: Queryable, attemptId: string, summary: Readonly<Record<string, unknown>>, providerReference: string | null = null): Promise<void> {
    await client.query(
      `UPDATE payments.attempts
          SET provider_response = provider_response || $2::jsonb, provider_reference = COALESCE(provider_reference, $3)
        WHERE id = $1`,
      [attemptId, JSON.stringify({ ...summary, checked_at: new Date().toISOString() }), providerReference],
    );
  }

  private async noteCheck(attemptId: string, error: unknown): Promise<void> {
    await this.deps.pool.query(
      "UPDATE payments.attempts SET provider_response = provider_response || $2::jsonb WHERE id = $1",
      [attemptId, JSON.stringify({ last_check_error: (error instanceof Error ? error.message : String(error)).slice(0, 300), checked_at: new Date().toISOString() })],
    );
  }

  private async transition(client: TransactionClient, transferId: string, status: TransferStatus, reason: string | null): Promise<void> {
    await client.query("UPDATE transfers.transfers SET status = $2::transfers.transfer_status, status_reason = $3 WHERE id = $1", [transferId, status, reason]);
  }

  private async emit(client: Queryable, transferId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
       VALUES ('transfer', $1, $2, $3::jsonb, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [transferId, eventType, JSON.stringify({ transfer_id: transferId, ...payload }), `${eventType}:${transferId}`],
    );
  }

  private async alert(client: Queryable, eventType: string, aggregateId: string, dedupKey: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
       VALUES ('payment_alert', $1, $2, $3::jsonb, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [aggregateId, eventType, JSON.stringify(payload), dedupKey],
    );
    this.deps.logger.warn({ eventType, aggregateId, ...payload }, "alerte paiements");
  }

  private async loadTransfer(db: Queryable, transferId: string): Promise<TransferRow> {
    const result = await db.query<TransferRow>(`SELECT ${TRANSFER_COLUMNS} FROM transfers.transfers t WHERE t.id = $1`, [transferId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`transfert introuvable : ${transferId}`);
    return row;
  }

  private async lockTransfer(client: TransactionClient, transferId: string): Promise<TransferRow> {
    const result = await client.query<TransferRow>(`SELECT ${TRANSFER_COLUMNS} FROM transfers.transfers t WHERE t.id = $1 FOR UPDATE`, [transferId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`transfert introuvable : ${transferId}`);
    return row;
  }

  private async loadAttempt(db: Queryable, attemptId: string): Promise<AttemptRow> {
    const result = await db.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.id = $1`, [attemptId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`tentative introuvable : ${attemptId}`);
    return row;
  }

  private async lockAttempt(client: TransactionClient, attemptId: string): Promise<AttemptRow> {
    const result = await client.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a WHERE a.id = $1 FOR UPDATE`, [attemptId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`tentative introuvable : ${attemptId}`);
    return row;
  }

  private async activeAttempt(db: Queryable, transferId: string, direction: "payin" | "payout" | "refund"): Promise<AttemptRow | null> {
    const result = await db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM payments.attempts a
        WHERE a.transfer_id = $1 AND a.direction = $2::payments.payment_direction AND a.status IN ('pending', 'requires_action', 'processing')`,
      [transferId, direction],
    );
    return result.rows[0] ?? null;
  }

  private async transferOfAttempt(attemptId: string): Promise<string> {
    return (await this.loadAttempt(this.deps.pool, attemptId)).transfer_id;
  }
}
