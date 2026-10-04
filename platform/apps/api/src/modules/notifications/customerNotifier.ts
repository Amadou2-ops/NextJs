import type { Logger } from "pino";

import type { DatabasePool } from "../../db/pool.js";
import { fieldContext } from "../../lib/crypto/fieldEncryption.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { formatMoney, Money, parseCurrencyCode } from "../../lib/money.js";
import { SmsDeliveryError } from "../../lib/sms/smsSender.js";
import type { SmsSender } from "../../lib/sms/smsSender.js";
import type { NotificationTemplate } from "./eventCatalog.js";

/**
 * Notification SMS du client à l'issue d'un transfert ou d'une vérification
 * d'identité.
 *
 * Exactement-une-fois du point de vue de la base, au-moins-une-fois du point
 * de vue du client : la notification est enregistrée (« sending ») avant
 * l'envoi, confirmée (« sent ») après. Un événement repris après une panne
 * entre l'envoi et la confirmation renvoie le SMS ; un événement déjà
 * confirmé n'est jamais renvoyé.
 *
 * Contenu minimal : référence et montant reçu, jamais le nom du bénéficiaire
 * ni un motif (refus d'identité, conformité). Le numéro, chiffré en base,
 * n'est déchiffré qu'au moment de l'envoi et n'est ni journalisé ni conservé.
 */

export interface NotifiableEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type NotificationOutcome = "sent" | "already_sent" | "abandoned" | "skipped";

interface Recipient {
  readonly user_id: string;
  readonly user_status: string;
  readonly phone_enc: Buffer;
}

interface TransferFacts extends Recipient {
  readonly reference: string;
  readonly destination_amount: string;
  readonly destination_currency: string;
  readonly minor_units: number;
}

const SMS_LOCALE = "fr-FR";
const BRAND = "TransfertPlus";

/** Espaces insécables du formatage français : absentes de l'alphabet GSM 7 bits. */
function gsmSpaces(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

export function renderNotification(template: NotificationTemplate, facts: { readonly reference?: string; readonly received?: string; readonly refundDestination?: string }): string {
  const reference = facts.reference ?? "";
  switch (template) {
    case "transfer_completed":
      return gsmSpaces(`${BRAND} : votre envoi ${reference} est arrivé. Le bénéficiaire a reçu ${facts.received ?? ""}.`);
    case "transfer_refunded":
      return facts.refundDestination === "payment_source"
        ? `${BRAND} : votre envoi ${reference} n'a pas pu aboutir. Le remboursement a été émis vers votre moyen de paiement.`
        : `${BRAND} : votre envoi ${reference} n'a pas pu aboutir. Il vous a été remboursé sur votre portefeuille ${BRAND}.`;
    case "transfer_cancelled":
      return `${BRAND} : votre envoi ${reference} a été annulé. Aucun montant ne vous a été débité.`;
    case "kyc_approved":
      return `${BRAND} : votre identité est vérifiée. Vous pouvez désormais envoyer de l'argent.`;
    case "kyc_rejected":
      return `${BRAND} : la vérification de votre identité n'a pas abouti. Ouvrez l'application pour en savoir plus.`;
    case "kyc_resubmission_required":
      return `${BRAND} : un nouveau document est nécessaire pour vérifier votre identité. Ouvrez l'application pour le transmettre.`;
    case "password_changed":
      return `${BRAND} : votre mot de passe vient d'être modifié et vos sessions fermées. Si ce n'est pas vous, contactez immédiatement notre service client.`;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class CustomerNotifier {
  constructor(
    private readonly deps: {
      readonly pool: DatabasePool;
      readonly sms: SmsSender;
      readonly encryptor: FieldEncryptor;
      readonly logger: Logger;
    },
  ) {}

  async notify(event: NotifiableEvent, template: NotificationTemplate): Promise<NotificationOutcome> {
    const facts = await this.factsOf(event, template);
    if (facts === null) {
      this.deps.logger.warn({ outboxId: event.id, template }, "notification sans objet : transfert ou vérification introuvable");
      return "skipped";
    }
    // Compte clôturé : plus aucun message.
    if (facts.recipient.user_status === "closed") return "skipped";

    const existing = await this.deps.pool.query<{ status: string }>(
      "SELECT status::text AS status FROM integrations.customer_notifications WHERE outbox_id = $1",
      [event.id],
    );
    const status = existing.rows[0]?.status;
    if (status === "sent") return "already_sent";
    if (status === "failed") return "abandoned";
    if (status === undefined) {
      await this.deps.pool.query(
        `INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
         VALUES ($1, $2, 'sms', $3)
         ON CONFLICT (outbox_id) DO NOTHING`,
        [event.id, facts.recipient.user_id, template],
      );
    }

    const phone = await this.deps.encryptor.decrypt(facts.recipient.phone_enc, fieldContext("identity", "users", "phone", facts.recipient.user_id));
    try {
      const { providerMessageId } = await this.deps.sms.send(phone, facts.body);
      await this.deps.pool.query(
        `UPDATE integrations.customer_notifications
            SET status = 'sent', provider_message_id = $2, sent_at = now(), last_error = NULL
          WHERE outbox_id = $1 AND status = 'sending'`,
        [event.id, providerMessageId.slice(0, 100)],
      );
      return "sent";
    } catch (error: unknown) {
      if (error instanceof SmsDeliveryError && !error.retryable) {
        // Numéro refusé par le prestataire : inutile d'insister.
        await this.deps.pool.query(
          "UPDATE integrations.customer_notifications SET status = 'failed', last_error = $2 WHERE outbox_id = $1 AND status = 'sending'",
          [event.id, errorText(error)],
        );
        this.deps.logger.warn({ outboxId: event.id, template, err: error }, "notification abandonnée : envoi refusé par le prestataire");
        return "abandoned";
      }
      await this.deps.pool.query(
        "UPDATE integrations.customer_notifications SET last_error = $2 WHERE outbox_id = $1 AND status = 'sending'",
        [event.id, errorText(error)],
      );
      throw error;
    }
  }

  private async factsOf(event: NotifiableEvent, template: NotificationTemplate): Promise<{ readonly recipient: Recipient; readonly body: string } | null> {
    if (event.aggregateType === "transfer") {
      const result = await this.deps.pool.query<TransferFacts>(
        `SELECT t.user_id, u.status::text AS user_status, u.phone_enc, t.reference,
                t.destination_amount::text AS destination_amount, t.destination_currency::text AS destination_currency, c.minor_units
           FROM transfers.transfers t
           JOIN identity.users u ON u.id = t.user_id
           JOIN ref.currencies c ON c.code = t.destination_currency
          WHERE t.id = $1`,
        [event.aggregateId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const received = formatMoney(Money.ofMinor(BigInt(row.destination_amount), parseCurrencyCode(row.destination_currency)), row.minor_units, SMS_LOCALE);
      const destination = event.payload["destination"];
      return {
        recipient: row,
        body: renderNotification(template, {
          reference: row.reference,
          received,
          ...(typeof destination === "string" ? { refundDestination: destination } : {}),
        }),
      };
    }
    if (event.aggregateType === "kyc_verification") {
      const result = await this.deps.pool.query<Recipient>(
        `SELECT v.user_id, u.status::text AS user_status, u.phone_enc
           FROM kyc.verifications v
           JOIN identity.users u ON u.id = v.user_id
          WHERE v.id = $1`,
        [event.aggregateId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { recipient: row, body: renderNotification(template, {}) };
    }
    if (event.aggregateType === "user") {
      const result = await this.deps.pool.query<Recipient>(
        "SELECT id AS user_id, status::text AS user_status, phone_enc FROM identity.users WHERE id = $1",
        [event.aggregateId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { recipient: row, body: renderNotification(template, {}) };
    }
    return null;
  }
}
