import type { Logger } from "pino";

import type { AppConfig } from "../../config/env.js";

/**
 * Envoi de SMS (codes à usage unique, alertes de sécurité).
 *
 * - TwilioSmsSender : API REST Twilio Messaging (Messaging Service, qui gère
 *   les identifiants d'expéditeur par pays et la conformité locale).
 * - LogSmsSender : développement et tests UNIQUEMENT (la configuration
 *   l'interdit en staging et production). Le message est journalisé.
 */

export interface SmsSender {
  send(toE164: string, body: string): Promise<{ readonly providerMessageId: string }>;
}

export class SmsDeliveryError extends Error {
  override readonly name = "SmsDeliveryError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly messagingServiceSid: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(toE164: string, body: string): Promise<{ readonly providerMessageId: string }> {
    if (!E164_PATTERN.test(toE164)) throw new SmsDeliveryError("numéro de destination invalide", false);
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: toE164, MessagingServiceSid: this.messagingServiceSid, Body: body }).toString(),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as { sid?: unknown; code?: unknown; message?: unknown };
    if (!response.ok) {
      throw new SmsDeliveryError(
        `Twilio a refusé l'envoi (HTTP ${response.status}, code ${typeof payload.code === "number" || typeof payload.code === "string" ? String(payload.code) : "?"})`,
        response.status >= 500 || response.status === 429,
      );
    }
    if (typeof payload.sid !== "string" || !/^SM[0-9a-f]{32}$/.test(payload.sid)) {
      throw new SmsDeliveryError("réponse Twilio inattendue", true);
    }
    return { providerMessageId: payload.sid };
  }
}

export class LogSmsSender implements SmsSender {
  private counter = 0;

  constructor(private readonly logger: Logger) {}

  send(toE164: string, body: string): Promise<{ readonly providerMessageId: string }> {
    this.counter += 1;
    this.logger.warn({ to: `${toE164.slice(0, 4)}•••${toE164.slice(-2)}`, devSmsBody: body }, "SMS de développement (non envoyé)");
    return Promise.resolve({ providerMessageId: `dev-${this.counter}` });
  }
}

/** Expéditeur configuré (Twilio, ou journal en développement et tests). */
export function smsSenderFromConfig(sms: AppConfig["auth"]["sms"], logger: Logger): SmsSender {
  return sms.provider === "twilio" ? new TwilioSmsSender(sms.accountSid, sms.authToken, sms.messagingServiceSid) : new LogSmsSender(logger);
}
