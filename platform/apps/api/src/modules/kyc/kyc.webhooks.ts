import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";

import { verifyHmacSignature, WebhookSignatureError } from "../../lib/crypto/webhookSignature.js";
import { AppError, AuthenticationError } from "../../lib/errors.js";
import { bodyEventId } from "../webhooks/webhookInbox.js";
import type { StoredWebhookEvent, WebhookHandlerResult, WebhookInbox, WebhookSource } from "../webhooks/webhookInbox.js";
import type { KycService } from "./kyc.service.js";
import { verifySmileCallback } from "./providers/smileId.client.js";

/**
 * Webhooks des prestataires KYC.
 *
 *   POST /v1/webhooks/onfido    en-tête X-SHA2-Signature = hex(HMAC-SHA256(jeton du webhook, corps brut))
 *   POST /v1/webhooks/smile-id  champs signature/timestamp du corps (schéma de signature Smile ID)
 *
 * Un webhook authentifié n'est qu'un signal : le résultat est relu chez le
 * prestataire (KycService.refresh). Un webhook non authentifié est tracé
 * (empreinte, taille, IP) puis refusé, sans aucun autre effet.
 */

export type WebhookProcessing = "background" | "inline";

const onfidoEventSchema = z.object({
  payload: z.object({
    resource_type: z.string().max(100),
    action: z.string().max(100),
    object: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      status: z.string().max(100).optional(),
      completed_at_iso8601: z.string().max(64).optional(),
    }),
  }),
});

export interface KycWebhookDependencies {
  readonly inbox: WebhookInbox;
  readonly logger: Logger;
  readonly processing: WebhookProcessing;
  readonly onfido: { readonly webhookToken: string } | undefined;
  readonly smileId: { readonly partnerId: string; readonly apiKey: string; readonly toleranceSeconds: number } | undefined;
}

function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function kycWebhookRoutes(deps: KycWebhookDependencies): Router {
  const router = Router();

  const reject = async (req: Request, source: WebhookSource, error: WebhookSignatureError): Promise<never> => {
    await deps.inbox.recordRejection({
      source,
      reason: error.reason,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      rawBody: req.rawBody ?? Buffer.alloc(0),
    });
    deps.logger.warn({ source, reason: error.reason, ip: req.ip }, "webhook refusé");
    if (error.reason === "malformed_payload") {
      throw new AppError("VALIDATION_FAILED", 400, "Webhook illisible", { detail: "Corps de webhook invalide." });
    }
    throw new AuthenticationError("Signature de webhook invalide.");
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

  if (deps.onfido !== undefined) {
    const { webhookToken } = deps.onfido;
    router.post(
      "/v1/webhooks/onfido",
      handle(async (req, res) => {
        const rawBody = req.rawBody ?? Buffer.alloc(0);
        try {
          verifyHmacSignature({
            secret: webhookToken,
            rawBody,
            signature: req.get("x-sha2-signature"),
            algorithm: "sha256",
            encoding: "hex",
          });
        } catch (error: unknown) {
          if (error instanceof WebhookSignatureError) await reject(req, "onfido", error);
          throw error;
        }
        const parsed = onfidoEventSchema.safeParse(req.body);
        if (!parsed.success) {
          await reject(req, "onfido", new WebhookSignatureError("malformed_payload", "événement Onfido illisible"));
          return;
        }
        const event = parsed.data.payload;
        const accepted = await deps.inbox.accept({
          source: "onfido",
          providerEventId: bodyEventId(rawBody),
          eventType: event.action,
          signedAt: null,
          payload: {
            resource_type: event.resource_type,
            action: event.action,
            object_id: event.object.id,
            object_status: event.object.status ?? null,
            completed_at: event.object.completed_at_iso8601 ?? null,
          },
          rawBody,
        });
        await acknowledge(res, accepted.eventId);
      }),
    );
  }

  if (deps.smileId !== undefined) {
    const smile = deps.smileId;
    router.post(
      "/v1/webhooks/smile-id",
      handle(async (req, res) => {
        const rawBody = req.rawBody ?? Buffer.alloc(0);
        let callback;
        try {
          callback = verifySmileCallback({ body: req.body, partnerId: smile.partnerId, apiKey: smile.apiKey, toleranceSeconds: smile.toleranceSeconds });
        } catch (error: unknown) {
          if (error instanceof WebhookSignatureError) await reject(req, "smile_id", error);
          throw error;
        }
        const accepted = await deps.inbox.accept({
          source: "smile_id",
          providerEventId: bodyEventId(rawBody),
          eventType: "job.result",
          signedAt: callback.signedAt,
          payload: {
            job_id: callback.jobId,
            user_id: callback.userId,
            result_code: callback.resultCode,
            smile_job_id: callback.smileJobId,
          },
          rawBody,
        });
        await acknowledge(res, accepted.eventId);
      }),
    );
  }

  return router;
}

/** Gestionnaires de traitement des événements KYC (inbox → KycService). */
export function registerKycWebhookHandlers(inbox: WebhookInbox, service: KycService, logger: Logger): void {
  inbox.register("onfido", async (event: StoredWebhookEvent): Promise<WebhookHandlerResult> => {
    if (event.payload["resource_type"] !== "workflow_run" || event.payload["action"] !== "workflow_run.completed") return "ignored";
    const runId = event.payload["object_id"];
    if (typeof runId !== "string") return "ignored";
    const verification = await service.findByProviderReference("onfido", runId);
    if (verification === null) {
      logger.warn({ eventId: event.id, runId }, "webhook Onfido pour un run inconnu");
      return "ignored";
    }
    await service.refresh(verification.id);
    return "processed";
  });

  inbox.register("smile_id", async (event: StoredWebhookEvent): Promise<WebhookHandlerResult> => {
    const jobId = event.payload["job_id"];
    const userId = event.payload["user_id"];
    if (typeof jobId !== "string" || typeof userId !== "string") return "ignored";
    const verification = await service.findByProviderReference("smile_id", jobId);
    if (verification?.userId !== userId) {
      logger.warn({ eventId: event.id, jobId }, "rappel Smile ID pour un job inconnu ou un autre client");
      return "ignored";
    }
    await service.refresh(verification.id);
    return "processed";
  });
}
