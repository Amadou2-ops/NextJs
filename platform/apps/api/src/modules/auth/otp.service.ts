import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import type { Queryable } from "../../db/transaction.js";
import type { BlindIndexer } from "../../lib/crypto/blindIndex.js";
import { RateLimitedError } from "../../lib/errors.js";
import type { SmsSender } from "../../lib/sms/smsSender.js";

/**
 * Codes à usage unique envoyés par SMS.
 *
 * - 6 chiffres tirés d'un générateur cryptographique ;
 * - stockés sous forme de HMAC lié à l'identifiant du défi (un code volé dans
 *   la base ne sert à rien, un code ne vaut que pour son défi) ;
 * - validité 5 minutes, 5 tentatives maximum, consommation unique ;
 * - au plus 5 codes par destinataire sur 15 minutes (anti-« SMS pumping »).
 */

export const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 5;
const OTP_WINDOW_MINUTES = 15;

export type OtpPurpose = "phone_verification" | "login" | "step_up" | "password_reset";

export interface CreatedOtp {
  readonly challengeId: string;
  readonly code: string;
  readonly expiresAt: Date;
}

export type OtpVerification =
  | { readonly ok: true; readonly userId: string | null; readonly destinationBidx: Buffer }
  | { readonly ok: false; readonly reason: "invalid_code" | "expired" | "exhausted" | "not_found" };

interface OtpRow {
  user_id: string | null;
  purpose: OtpPurpose;
  destination_bidx: Buffer;
  code_hmac: Buffer;
  attempts: number;
  max_attempts: number;
  expired: boolean;
  consumed_at: Date | null;
}

export class OtpService {
  constructor(
    private readonly hmacKey: Buffer,
    private readonly indexer: BlindIndexer,
    private readonly sms: SmsSender,
  ) {}

  destinationIndex(phoneE164: string): Buffer {
    return this.indexer.compute("otp_destination", phoneE164);
  }

  private codeHmac(challengeId: string, code: string): Buffer {
    return createHmac("sha256", this.hmacKey).update(`transfertplus/otp/v1/${challengeId}/${code}`, "utf8").digest();
  }

  /** Crée un défi dans la transaction fournie (le code n'est PAS encore envoyé). */
  async create(
    db: Queryable,
    params: { readonly purpose: OtpPurpose; readonly phoneE164: string; readonly userId: string | null; readonly ipAddress: string | undefined },
  ): Promise<CreatedOtp> {
    const destinationBidx = this.destinationIndex(params.phoneE164);
    const recent = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identity.otp_challenges
        WHERE destination_bidx = $1 AND created_at > now() - make_interval(mins => $2)`,
      [destinationBidx, OTP_WINDOW_MINUTES],
    );
    if (Number(recent.rows[0]?.count ?? "0") >= OTP_MAX_PER_WINDOW) {
      throw new RateLimitedError(OTP_WINDOW_MINUTES * 60);
    }
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const inserted = await db.query<{ expires_at: Date }>(
      `INSERT INTO identity.otp_challenges (id, user_id, purpose, channel, destination_bidx, code_hmac, max_attempts, ip_address, expires_at)
       VALUES ($1, $2, $3, 'sms', $4, $5, $6, $7, now() + make_interval(secs => $8))
       RETURNING expires_at`,
      [challengeId, params.userId, params.purpose, destinationBidx, this.codeHmac(challengeId, code), OTP_MAX_ATTEMPTS, params.ipAddress ?? null, OTP_TTL_SECONDS],
    );
    const expiresAt = inserted.rows[0]?.expires_at;
    if (expiresAt === undefined) throw new Error("création du défi OTP impossible");
    return { challengeId, code, expiresAt };
  }

  /**
   * Vérifie un code. N'émet jamais d'exception pour un code faux : le
   * compteur de tentatives doit être VALIDÉ (COMMIT) même en cas d'échec ;
   * l'appelant lève l'erreur après la transaction.
   */
  async verify(
    db: Queryable,
    params: { readonly challengeId: string; readonly code: string; readonly purpose: OtpPurpose },
  ): Promise<OtpVerification> {
    const result = await db.query<OtpRow>(
      `SELECT user_id, purpose, destination_bidx, code_hmac, attempts, max_attempts,
              expires_at <= now() AS expired, consumed_at
         FROM identity.otp_challenges
        WHERE id = $1
          FOR UPDATE`,
      [params.challengeId],
    );
    const row = result.rows[0];
    if (row?.purpose !== params.purpose) return { ok: false, reason: "not_found" };
    if (row.consumed_at !== null || row.expired) return { ok: false, reason: "expired" };
    if (row.attempts >= row.max_attempts) return { ok: false, reason: "exhausted" };

    const candidate = /^\d{6}$/.test(params.code) ? this.codeHmac(params.challengeId, params.code) : Buffer.alloc(32);
    if (!timingSafeEqual(candidate, row.code_hmac)) {
      await db.query("UPDATE identity.otp_challenges SET attempts = attempts + 1 WHERE id = $1", [params.challengeId]);
      return { ok: false, reason: row.attempts + 1 >= row.max_attempts ? "exhausted" : "invalid_code" };
    }
    await db.query("UPDATE identity.otp_challenges SET attempts = attempts + 1, consumed_at = now() WHERE id = $1", [params.challengeId]);
    return { ok: true, userId: row.user_id, destinationBidx: row.destination_bidx };
  }

  async sendCode(phoneE164: string, code: string, locale: string): Promise<void> {
    const body = locale.startsWith("en")
      ? `TransfertPlus: your code is ${code}. It expires in 5 minutes. Never share it, not even with our support team.`
      : `TransfertPlus : votre code est ${code}. Il expire dans 5 minutes. Ne le communiquez jamais, même à notre service client.`;
    await this.sms.send(phoneE164, body);
  }

  async sendExistingAccountNotice(phoneE164: string, locale: string): Promise<void> {
    const body = locale.startsWith("en")
      ? "TransfertPlus: someone tried to create an account with your number. You already have an account: sign in instead. If this wasn't you, ignore this message."
      : "TransfertPlus : une création de compte a été tentée avec votre numéro. Vous avez déjà un compte : connectez-vous. Si ce n'était pas vous, ignorez ce message.";
    await this.sms.send(phoneE164, body);
  }
}
