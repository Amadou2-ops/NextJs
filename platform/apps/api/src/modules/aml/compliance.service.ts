import type { Logger } from "pino";

import type { TransactionClient } from "../../db/transaction.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import type { ScreeningResult, ScreeningService } from "./screening.service.js";

/**
 * Évaluation AML d'un transfert financé, avant tout paiement au bénéficiaire.
 *
 * Dans la transaction qui constate le financement :
 *   1. criblage de l'expéditeur (identité vérifiée) et du bénéficiaire ;
 *   2. évaluation de chaque règle active (aml.rules, paramètres en base) ;
 *   3. une alerte par règle déclenchée ; si l'une d'elles est bloquante, le
 *      transfert passe en compliance_review, sinon en payout_pending ;
 *   4. évaluation conservée (immuable) avec la valeur mesurée de chaque
 *      règle, profil de risque du client recalculé.
 * La base refuse le paiement d'un transfert sans évaluation favorable, et la
 * sortie de revue tant qu'une alerte bloquante n'a pas été levée par un
 * analyste (migration 0022).
 */

export type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_SCORE: Readonly<Record<Severity, number>> = { low: 25, medium: 50, high: 75, critical: 95 };

interface RuleRow {
  code: string;
  severity: Severity;
  blocks_transfer: boolean;
  parameters: Record<string, unknown>;
}

interface TransferContext {
  id: string;
  reference: string;
  user_id: string;
  recipient_id: string;
  source_country: string;
  destination_country: string;
  source_currency: string;
  total_debit: bigint;
  usd_equivalent: bigint;
  funding_method: string;
  authorized_device_id: string | null;
  status: string;
}

export interface RuleResult {
  readonly rule: string;
  readonly triggered: boolean;
  readonly severity: Severity;
  readonly blocking: boolean;
  readonly measured: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EvaluationOutcome {
  readonly outcome: "clear" | "review";
  readonly riskScore: number;
  readonly results: readonly RuleResult[];
}

function numberParameter(rule: RuleRow, key: string): number {
  const value = rule.parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`règle ${rule.code} : paramètre ${key} absent ou invalide`);
  return value;
}

export class ComplianceService {
  constructor(
    private readonly deps: {
      readonly screening: ScreeningService;
      readonly encryptor: FieldEncryptor;
      readonly logger: Logger;
    },
  ) {}

  /**
   * Évalue un transfert au statut funded et le dirige vers le paiement ou la
   * revue. Idempotent : une évaluation existante est réappliquée telle quelle.
   */
  async evaluateAndRoute(client: TransactionClient, transferId: string): Promise<"clear" | "review"> {
    const existing = await client.query<{ outcome: "clear" | "review" }>("SELECT outcome::text AS outcome FROM aml.transfer_evaluations WHERE transfer_id = $1", [transferId]);
    const transfer = await this.loadTransfer(client, transferId);
    const outcome = existing.rows[0]?.outcome ?? (await this.evaluate(client, transfer)).outcome;
    if (transfer.status === "funded") {
      await client.query("UPDATE transfers.transfers SET status = $2::transfers.transfer_status, status_reason = $3 WHERE id = $1", [
        transferId,
        outcome === "clear" ? "payout_pending" : "compliance_review",
        outcome === "clear" ? null : "aml_review",
      ]);
    }
    return outcome;
  }

  private async evaluate(client: TransactionClient, transfer: TransferContext): Promise<EvaluationOutcome> {
    const sender = await this.senderIdentity(client, transfer.user_id);
    const recipient = await this.recipientIdentity(client, transfer.recipient_id);
    const senderScreening = await this.deps.screening.screen(client, { type: "user", id: transfer.user_id, fullName: sender.fullName, birthDate: sender.birthDate });
    const recipientScreening = await this.deps.screening.screen(client, { type: "recipient", id: transfer.recipient_id, fullName: recipient.fullName, birthDate: null });

    const rules = await client.query<RuleRow>("SELECT code, severity::text AS severity, blocks_transfer, parameters FROM aml.rules WHERE is_enabled ORDER BY code");
    const results: RuleResult[] = [];
    for (const rule of rules.rows) {
      const measured = await this.measure(client, rule, transfer, recipient.accountBidx, senderScreening, recipientScreening);
      results.push({ rule: rule.code, triggered: measured.triggered, severity: rule.severity, blocking: rule.blocks_transfer, measured: measured.values });
    }

    const triggered = results.filter((result) => result.triggered);
    const outcome: "clear" | "review" = triggered.some((result) => result.blocking) ? "review" : "clear";
    const riskScore = Math.min(100, triggered.reduce((score, result) => Math.max(score, SEVERITY_SCORE[result.severity]), 10) + Math.max(0, triggered.length - 1) * 5);

    for (const result of triggered) {
      const screeningId =
        result.rule === "SANCTIONS_POTENTIAL_MATCH" || result.rule === "PEP_MATCH" || result.rule === "SCREENING_UNAVAILABLE"
          ? (senderScreening.status !== "clear" ? senderScreening.id : recipientScreening.id)
          : null;
      const alert = await client.query<{ id: string }>(
        `INSERT INTO aml.alerts (user_id, transfer_id, screening_id, rule_code, severity, score, details)
         VALUES ($1, $2, $3, $4, $5::aml.severity, $6, $7::jsonb)
         ON CONFLICT (rule_code, transfer_id) WHERE transfer_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [transfer.user_id, transfer.id, screeningId, result.rule, result.severity, SEVERITY_SCORE[result.severity], JSON.stringify({ measured: result.measured, blocking: result.blocking })],
      );
      const alertId = alert.rows[0]?.id;
      if (alertId !== undefined) {
        await this.emit(client, "aml_alert", alertId, "aml.alert_raised", `aml.alert_raised:${alertId}`, {
          alert_id: alertId,
          transfer_id: transfer.id,
          user_id: transfer.user_id,
          rule: result.rule,
          severity: result.severity,
          blocking: result.blocking,
        });
      }
    }

    await client.query(
      `INSERT INTO aml.transfer_evaluations (transfer_id, outcome, sender_screening_id, recipient_screening_id, rule_results, risk_score)
       VALUES ($1, $2::aml.evaluation_outcome, $3, $4, $5::jsonb, $6)`,
      [transfer.id, outcome, senderScreening.id, recipientScreening.id, JSON.stringify(results), riskScore],
    );
    if (outcome === "review") {
      await this.emit(client, "transfer", transfer.id, "aml.transfer_review_required", `aml.transfer_review_required:${transfer.id}`, {
        transfer_id: transfer.id,
        reference: transfer.reference,
        rules: triggered.filter((result) => result.blocking).map((result) => result.rule),
      });
    }
    await this.updateRiskProfile(client, transfer, senderScreening);
    this.deps.logger.info({ transferId: transfer.id, outcome, triggered: triggered.map((result) => result.rule) }, "évaluation AML");
    return { outcome, riskScore, results };
  }

  private async measure(
    client: TransactionClient,
    rule: RuleRow,
    transfer: TransferContext,
    recipientBidx: Buffer,
    sender: ScreeningResult,
    recipient: ScreeningResult,
  ): Promise<{ readonly triggered: boolean; readonly values: Readonly<Record<string, string | number | boolean | null>> }> {
    switch (rule.code) {
      case "SINGLE_LARGE_TRANSFER": {
        const threshold = numberParameter(rule, "threshold_usd_minor");
        return { triggered: transfer.usd_equivalent >= BigInt(threshold), values: { usd_equivalent: transfer.usd_equivalent.toString(), threshold } };
      }
      case "VELOCITY_24H": {
        const threshold = numberParameter(rule, "threshold_usd_minor");
        const hours = numberParameter(rule, "window_hours");
        const volume = await client.query<{ total: bigint }>("SELECT total_usd_minor AS total FROM aml.user_volume_usd($1, now() - make_interval(hours => $2))", [transfer.user_id, hours]);
        const total = volume.rows[0]?.total ?? 0n;
        return { triggered: total > BigInt(threshold), values: { total_usd_minor: total.toString(), threshold, window_hours: hours } };
      }
      case "VELOCITY_COUNT_1H": {
        const maxCount = numberParameter(rule, "max_count");
        const hours = numberParameter(rule, "window_hours");
        const volume = await client.query<{ count: bigint }>("SELECT transfer_count AS count FROM aml.user_volume_usd($1, now() - make_interval(hours => $2))", [transfer.user_id, hours]);
        const count = Number(volume.rows[0]?.count ?? 0n);
        return { triggered: count > maxCount, values: { count, max_count: maxCount, window_hours: hours } };
      }
      case "STRUCTURING": {
        const threshold = numberParameter(rule, "threshold_usd_minor");
        const band = numberParameter(rule, "band_percent");
        const days = numberParameter(rule, "window_days");
        const minCount = numberParameter(rule, "min_count");
        const floor = Math.floor((threshold * (100 - band)) / 100);
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM transfers.transfers
            WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)
              AND status NOT IN ('cancelled', 'refunded')
              AND usd_equivalent >= $3 AND usd_equivalent < $4`,
          [transfer.user_id, days, floor, threshold],
        );
        const count = Number(result.rows[0]?.count ?? "0");
        return { triggered: count >= minCount, values: { count, band_floor_usd_minor: floor, threshold, min_count: minCount } };
      }
      case "SHARED_RECIPIENT": {
        const days = numberParameter(rule, "window_days");
        const maxSenders = numberParameter(rule, "max_distinct_senders");
        const result = await client.query<{ senders: bigint }>("SELECT aml.recipient_distinct_senders($1, now() - make_interval(days => $2)) AS senders", [recipientBidx, days]);
        const senders = Number(result.rows[0]?.senders ?? 0n);
        return { triggered: senders > maxSenders, values: { distinct_senders: senders, max_distinct_senders: maxSenders } };
      }
      case "HIGH_RISK_COUNTRY": {
        const result = await client.query<{ alpha2: string }>(
          `SELECT c.alpha2 FROM ref.countries c
            WHERE c.risk_level IN ('high', 'prohibited')
              AND c.alpha2 IN ($1, $2, (SELECT country_of_residence FROM identity.users WHERE id = $3), (SELECT nationality FROM identity.users WHERE id = $3))`,
          [transfer.source_country, transfer.destination_country, transfer.user_id],
        );
        return { triggered: result.rows.length > 0, values: { countries: result.rows.map((row) => row.alpha2).join(",") || null } };
      }
      case "SANCTIONS_POTENTIAL_MATCH": {
        const matches = [...sender.sanctionsMatches, ...recipient.sanctionsMatches];
        return {
          triggered: matches.length > 0,
          values: { sender_matches: sender.sanctionsMatches.length, recipient_matches: recipient.sanctionsMatches.length, best_score: matches[0]?.score ?? null },
        };
      }
      case "PEP_MATCH":
        return { triggered: sender.pepMatches.length > 0, values: { matches: sender.pepMatches.length, best_score: sender.pepMatches[0]?.score ?? null } };
      case "SCREENING_UNAVAILABLE":
        return { triggered: !sender.listsAvailable || !recipient.listsAvailable, values: { lists_available: sender.listsAvailable && recipient.listsAvailable } };
      case "NEW_DEVICE_LARGE_TRANSFER": {
        const threshold = numberParameter(rule, "threshold_usd_minor");
        const hours = numberParameter(rule, "device_age_hours");
        if (transfer.authorized_device_id === null) return { triggered: false, values: { device: null } };
        const device = await client.query<{ recent: boolean }>("SELECT created_at > now() - make_interval(hours => $2) AS recent FROM identity.devices WHERE id = $1", [transfer.authorized_device_id, hours]);
        const recent = device.rows[0]?.recent === true;
        return { triggered: recent && transfer.usd_equivalent >= BigInt(threshold), values: { recent_device: recent, usd_equivalent: transfer.usd_equivalent.toString(), threshold } };
      }
      case "RAPID_IN_OUT": {
        const hours = numberParameter(rule, "window_hours");
        const ratio = numberParameter(rule, "ratio_percent");
        if (transfer.funding_method !== "wallet_balance") return { triggered: false, values: { funding: transfer.funding_method } };
        const credits = await client.query<{ total: string }>(
          `SELECT COALESCE(sum(e.amount), 0)::text AS total
             FROM ledger.entries e
             JOIN ledger.journals j ON j.id = e.journal_id
             JOIN ledger.accounts a ON a.id = e.account_id
            WHERE a.owner_user_id = $1 AND a.account_type = 'customer_wallet' AND a.currency = $2
              AND e.direction = 'credit' AND j.journal_type = 'wallet_funding'
              AND j.created_at > now() - make_interval(hours => $3)`,
          [transfer.user_id, transfer.source_currency, hours],
        );
        const received = BigInt(credits.rows[0]?.total ?? "0");
        const triggered = received > 0n && transfer.total_debit * 100n >= received * BigInt(ratio);
        return { triggered, values: { received_minor: received.toString(), sent_minor: transfer.total_debit.toString(), ratio_percent: ratio } };
      }
      default:
        // Règle inconnue de ce code : son absence d'évaluation est une anomalie, jamais un succès silencieux.
        throw new Error(`règle AML non implémentée : ${rule.code}`);
    }
  }

  private async updateRiskProfile(client: TransactionClient, transfer: TransferContext, sender: ScreeningResult): Promise<void> {
    const factors = await client.query<{ high_risk_residence: boolean; alerts_90d: string }>(
      `SELECT COALESCE((SELECT c.risk_level IN ('high', 'prohibited') FROM ref.countries c JOIN identity.users u ON u.country_of_residence = c.alpha2 WHERE u.id = $1), false) AS high_risk_residence,
              (SELECT count(*)::text FROM aml.alerts a WHERE a.user_id = $1 AND a.created_at > now() - interval '90 days') AS alerts_90d`,
      [transfer.user_id],
    );
    const row = factors.rows[0];
    const alerts = Number(row?.alerts_90d ?? "0");
    const score = Math.min(
      100,
      20 + (row?.high_risk_residence === true ? 20 : 0) + Math.min(40, alerts * 10) + (sender.pepMatches.length > 0 ? 25 : 0) + (sender.sanctionsMatches.length > 0 ? 30 : 0),
    );
    const level = score >= 65 ? "high" : score >= 35 ? "medium" : "low";
    await client.query(
      `INSERT INTO aml.customer_risk_profiles (user_id, risk_level, risk_score, factors, last_assessed_at, next_review_at)
       VALUES ($1, $2::aml.risk_level, $3, $4::jsonb, now(), now() + make_interval(days => $5))
       ON CONFLICT (user_id) DO UPDATE
          SET risk_level = CASE WHEN aml.customer_risk_profiles.risk_level = 'unacceptable' THEN aml.customer_risk_profiles.risk_level ELSE EXCLUDED.risk_level END,
              risk_score = GREATEST(EXCLUDED.risk_score, CASE WHEN aml.customer_risk_profiles.is_sanctioned THEN 100 ELSE 0 END),
              factors = EXCLUDED.factors,
              last_assessed_at = now(),
              next_review_at = EXCLUDED.next_review_at`,
      [
        transfer.user_id,
        level,
        score,
        JSON.stringify({ high_risk_residence: row?.high_risk_residence ?? false, alerts_90d: alerts, pep_potential: sender.pepMatches.length > 0, sanctions_potential: sender.sanctionsMatches.length > 0 }),
        level === "high" ? 180 : 365,
      ],
    );
  }

  private async senderIdentity(client: TransactionClient, userId: string): Promise<{ readonly fullName: string; readonly birthDate: string | null }> {
    const result = await client.query<{ first_name_enc: Buffer | null; last_name_enc: Buffer | null; date_of_birth_enc: Buffer | null }>(
      "SELECT first_name_enc, last_name_enc, date_of_birth_enc FROM identity.users WHERE id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (row?.first_name_enc === null || row?.first_name_enc === undefined || row.last_name_enc === null) {
      throw new Error("identité de l'expéditeur absente : criblage impossible");
    }
    const context = (column: string): string => fieldContext("identity", "users", column, userId);
    return {
      fullName: `${await this.deps.encryptor.decrypt(row.first_name_enc, context("first_name"))} ${await this.deps.encryptor.decrypt(row.last_name_enc, context("last_name"))}`,
      birthDate: row.date_of_birth_enc === null ? null : await this.deps.encryptor.decrypt(row.date_of_birth_enc, context("date_of_birth")),
    };
  }

  private async recipientIdentity(client: TransactionClient, recipientId: string): Promise<{ readonly fullName: string; readonly accountBidx: Buffer }> {
    const result = await client.query<{ full_name_enc: Buffer; account_details_bidx: Buffer }>("SELECT full_name_enc, account_details_bidx FROM transfers.recipients WHERE id = $1", [recipientId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("bénéficiaire introuvable");
    const name = JSON.parse(await this.deps.encryptor.decrypt(row.full_name_enc, fieldContext("transfers", "recipients", "full_name", recipientId))) as { firstName: string; lastName: string };
    return { fullName: `${name.firstName} ${name.lastName}`, accountBidx: row.account_details_bidx };
  }

  private async loadTransfer(client: TransactionClient, transferId: string): Promise<TransferContext> {
    const result = await client.query<TransferContext>(
      `SELECT id, reference, user_id, recipient_id, source_country, destination_country, source_currency, total_debit, usd_equivalent,
              funding_method::text, authorized_device_id, status::text
         FROM transfers.transfers WHERE id = $1 FOR UPDATE`,
      [transferId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("transfert introuvable");
    return row;
  }

  private async emit(client: TransactionClient, aggregateType: string, aggregateId: string, eventType: string, dedupKey: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload), dedupKey],
    );
  }
}
