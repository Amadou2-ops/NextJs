import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";

import { verifySharedSecretHeader, verifyTimestampedHmacHeader, WebhookSignatureError } from "../../lib/crypto/webhookSignature.js";
import { AppError, AuthenticationError } from "../../lib/errors.js";
import { parseJsonPreservingNumbers } from "../../lib/json.js";
import { bodyEventId } from "../webhooks/webhookInbox.js";
import type { StoredWebhookEvent, WebhookHandlerResult, WebhookInbox, WebhookRejectionReason, WebhookSource } from "../webhooks/webhookInbox.js";
import type { PaymentOrchestrator } from "./payment.orchestrator.js";

/**
 * Webhooks des prestataires de paiement.
 *
 *   POST /v1/webhooks/stripe       en-tête Stripe-Signature : t=<horodatage>,v1=HMAC-SHA256(secret, "t.corps brut"),
 *                                  tolérance 5 min (anti-rejeu) ; le corps entier est authentifié.
 *   POST /v1/webhooks/flutterwave  en-tête verif-hash : secret partagé (comparaison à durée constante).
 *                                  Le corps n'étant pas signé, il n'est qu'un signal : l'état est relu chez Flutterwave.
 *   POST /v1/webhooks/thunes       rappel de statut sans signature documentée : liste blanche d'adresses si
 *                                  configurée, et toujours relecture authentifiée de la transaction chez Thunes.
 *
 * Dans tous les cas l'état appliqué est celui relu chez le prestataire (ou,
 * pour les litiges Stripe, celui du corps intégralement signé).
 */

export type PaymentWebhookProcessing = "background" | "inline";

const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.string().max(100),
  data: z.object({
    object: z
      .object({
        id: z.string().max(100),
        object: z.string().max(50).optional(),
        payment_intent: z.string().max(100).nullish(),
        amount: z.string().regex(/^\d{1,18}$/).optional(),
        currency: z.string().regex(/^[a-z]{3}$/).optional(),
      })
      .loose(),
  }),
});

const flutterwaveEventSchema = z.object({
  event: z.string().max(100),
  data: z
    .object({
      id: z.string().regex(/^\d{1,20}$/).optional(),
      tx_ref: z.string().max(100).optional(),
      reference: z.string().max(100).optional(),
      status: z.string().max(50).optional(),
    })
    .loose(),
});

const thunesCallbackSchema = z
  .object({
    external_id: z.string().max(150),
    id: z.string().max(40).optional(),
    status_class: z.string().max(5).optional(),
  })
  .loose();

export interface PaymentWebhookDependencies {
  readonly inbox: WebhookInbox;
  readonly logger: Logger;
  readonly processing: PaymentWebhookProcessing;
  readonly stripe: { readonly webhookSecret: string } | undefined;
  readonly flutterwave: { readonly webhookHash: string } | undefined;
  readonly thunes: { readonly allowedIps: readonly string[] } | undefined;
}

export function paymentWebhookRoutes(deps: PaymentWebhookDependencies): Router {
  const router = Router();
  const handle =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
      handler(req, res).catch(next);
    };

  const reject = async (req: Request, source: WebhookSource, reason: WebhookRejectionReason): Promise<never> => {
    await deps.inbox.recordRejection({ source, reason, ipAddress: req.ip, userAgent: req.get("user-agent"), rawBody: req.rawBody ?? Buffer.alloc(0) });
    deps.logger.warn({ source, reason, ip: req.ip }, "webhook refusé");
    if (reason === "malformed_payload") throw new AppError("VALIDATION_FAILED", 400, "Webhook illisible", { detail: "Corps de webhook invalide." });
    throw new AuthenticationError("Webhook non authentifié.");
  };

  const acknowledge = async (res: Response, eventId: string): Promise<void> => {
    if (deps.processing === "inline") {
      await deps.inbox.process(eventId);
    } else {
      setImmediate(() => {
        deps.inbox.process(eventId).catch((error: unknown) => {
          deps.logger.error({ err: error, eventId }, "traitement différé du webhook en échec");
        });
      });
    }
    res.status(200).json({ received: true });
  };

  const rawJson = (req: Request): unknown => {
    try {
      return parseJsonPreservingNumbers((req.rawBody ?? Buffer.alloc(0)).toString("utf8"));
    } catch {
      return null;
    }
  };

  if (deps.stripe !== undefined) {
    const secret = deps.stripe.webhookSecret;
    router.post(
      "/v1/webhooks/stripe",
      handle(async (req, res) => {
        const rawBody = req.rawBody ?? Buffer.alloc(0);
        let signedAt: number;
        try {
          signedAt = verifyTimestampedHmacHeader({ header: req.get("stripe-signature"), secret, rawBody, toleranceSeconds: 300 }).timestamp;
        } catch (error: unknown) {
          if (error instanceof WebhookSignatureError) return reject(req, "stripe", error.reason);
          throw error;
        }
        const parsed = stripeEventSchema.safeParse(rawJson(req));
        if (!parsed.success) return reject(req, "stripe", "malformed_payload");
        const event = parsed.data;
        const object = event.data.object;
        const accepted = await deps.inbox.accept({
          source: "stripe",
          providerEventId: event.id,
          eventType: event.type,
          signedAt: new Date(signedAt * 1000),
          payload: {
            type: event.type,
            object_id: object.id,
            payment_intent: object.payment_intent ?? null,
            amount: object.amount ?? null,
            currency: object.currency ?? null,
          },
          rawBody,
        });
        await acknowledge(res, accepted.eventId);
      }),
    );
  }

  if (deps.flutterwave !== undefined) {
    const hash = deps.flutterwave.webhookHash;
    router.post(
      "/v1/webhooks/flutterwave",
      handle(async (req, res) => {
        const rawBody = req.rawBody ?? Buffer.alloc(0);
        try {
          verifySharedSecretHeader(hash, req.get("verif-hash"));
        } catch (error: unknown) {
          if (error instanceof WebhookSignatureError) return reject(req, "flutterwave", error.reason);
          throw error;
        }
        const parsed = flutterwaveEventSchema.safeParse(rawJson(req));
        if (!parsed.success) return reject(req, "flutterwave", "malformed_payload");
        const event = parsed.data;
        const accepted = await deps.inbox.accept({
          source: "flutterwave",
          providerEventId: bodyEventId(rawBody),
          eventType: event.event,
          signedAt: null,
          payload: {
            event: event.event,
            data_id: event.data.id ?? null,
            tx_ref: event.data.tx_ref ?? null,
            reference: event.data.reference ?? null,
            status: event.data.status ?? null,
          },
          rawBody,
        });
        await acknowledge(res, accepted.eventId);
      }),
    );
  }

  if (deps.thunes !== undefined) {
    const allowed = new Set(deps.thunes.allowedIps.map((ip) => ip.toLowerCase()));
    router.post(
      "/v1/webhooks/thunes",
      handle(async (req, res) => {
        const rawBody = req.rawBody ?? Buffer.alloc(0);
        const ip = (req.ip ?? "").replace(/^::ffff:/, "").toLowerCase();
        if (allowed.size > 0 && !allowed.has(ip)) return reject(req, "thunes", "unknown_source");
        const parsed = thunesCallbackSchema.safeParse(rawJson(req));
        if (!parsed.success) return reject(req, "thunes", "malformed_payload");
        const accepted = await deps.inbox.accept({
          source: "thunes",
          providerEventId: bodyEventId(rawBody),
          eventType: "transaction.status",
          signedAt: null,
          payload: { external_id: parsed.data.external_id, transaction_id: parsed.data.id ?? null, status_class: parsed.data.status_class ?? null },
          rawBody,
        });
        await acknowledge(res, accepted.eventId);
      }),
    );
  }

  return router;
}

/** Gestionnaires : chaque événement déclenche la relecture de la tentative concernée. */
export function registerPaymentWebhookHandlers(inbox: WebhookInbox, orchestrator: PaymentOrchestrator, logger: Logger): void {
  const stringField = (event: StoredWebhookEvent, key: string): string | null => {
    const value = event.payload[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  inbox.register("stripe", async (event): Promise<WebhookHandlerResult> => {
    const type = stringField(event, "type") ?? "";
    const objectId = stringField(event, "object_id");
    if (objectId === null) return "ignored";
    if (type.startsWith("payment_intent.")) {
      const attempt = await orchestrator.findAttempt({ provider: "stripe", providerReference: objectId });
      if (attempt === null) {
        logger.warn({ eventId: event.id, objectId }, "événement Stripe pour un PaymentIntent inconnu");
        return "ignored";
      }
      await orchestrator.refreshPayin(attempt.id);
      return "processed";
    }
    if (type.startsWith("refund.") || type === "charge.refund.updated") {
      const attempt = await orchestrator.findAttempt({ provider: "stripe", providerReference: objectId });
      if (attempt?.direction !== "refund") return "ignored";
      await orchestrator.refreshRefund(attempt.id);
      return "processed";
    }
    if (type === "charge.dispute.funds_withdrawn" || type === "charge.dispute.funds_reinstated") {
      const paymentIntent = stringField(event, "payment_intent");
      const amount = stringField(event, "amount");
      const currency = stringField(event, "currency");
      if (paymentIntent === null || amount === null || currency === null) return "ignored";
      // Montant Stripe en unités mineures, corps intégralement signé.
      return orchestrator.applyDispute({
        disputeId: objectId,
        paymentIntentId: paymentIntent,
        kind: type === "charge.dispute.funds_withdrawn" ? "funds_withdrawn" : "funds_reinstated",
        amount: { amountMinor: BigInt(amount), currency: currency.toUpperCase() },
      });
    }
    return "ignored";
  });

  inbox.register("flutterwave", async (event): Promise<WebhookHandlerResult> => {
    const type = stringField(event, "event") ?? "";
    if (type === "charge.completed") {
      const txRef = stringField(event, "tx_ref");
      if (txRef === null) return "ignored";
      const attempt = await orchestrator.findAttempt({ provider: "flutterwave", idempotencyKey: txRef });
      if (attempt?.direction !== "payin") return "ignored";
      await orchestrator.refreshPayin(attempt.id);
      return "processed";
    }
    if (type === "transfer.completed") {
      const reference = stringField(event, "reference");
      const dataId = stringField(event, "data_id");
      const attempt =
        (reference === null ? null : await orchestrator.findAttempt({ provider: "flutterwave", idempotencyKey: reference })) ??
        (dataId === null ? null : await orchestrator.findAttempt({ provider: "flutterwave", providerReference: dataId }));
      if (attempt?.direction !== "payout") return "ignored";
      await orchestrator.refreshPayout(attempt.id);
      return "processed";
    }
    return "ignored";
  });

  inbox.register("thunes", async (event): Promise<WebhookHandlerResult> => {
    const externalId = stringField(event, "external_id");
    if (externalId === null) return "ignored";
    const attempt = await orchestrator.findAttempt({ provider: "thunes", idempotencyKey: externalId });
    if (attempt?.direction !== "payout") return "ignored";
    await orchestrator.refreshPayout(attempt.id);
    return "processed";
  });
}
