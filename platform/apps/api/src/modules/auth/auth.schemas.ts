import { z } from "zod";

import { PASSWORD_MAX_LENGTH } from "./password.service.js";

/**
 * Schémas des requêtes d'authentification (objets stricts : toute propriété
 * inconnue est refusée).
 */

const uuid = z.uuid();
const phone = z.string().trim().min(6).max(32).regex(/^[+0-9 ().-]+$/, "numéro de téléphone invalide");
const country = z.string().regex(/^[A-Z]{2}$/, "code pays ISO 3166-1 alpha-2 attendu");
const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("fr");
const otpCode = z.string().regex(/^\d{6}$/, "code à 6 chiffres attendu");
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64 attendu");

const attestationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("app_attest"),
      keyId: base64.max(64),
      attestationObject: base64.max(22_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("play_integrity"),
      integrityToken: z.string().regex(/^[A-Za-z0-9._-]{100,8192}$/),
    })
    .strict(),
]);

export const deviceRegistrationSchema = z
  .object({
    challengeId: uuid,
    platform: z.enum(["ios", "android"]),
    name: z.string().trim().min(1).max(80),
    appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
    osVersion: z.string().regex(/^[0-9A-Za-z. ()+-]{1,40}$/),
    publicKey: base64.max(200),
    publicKeyAlgorithm: z.enum(["ES256", "EdDSA"]),
    attestation: attestationSchema,
  })
  .strict();

export const clientSchema = z.union([
  z.object({ type: z.literal("web") }).strict(),
  z.object({ type: z.literal("mobile"), device: deviceRegistrationSchema }).strict(),
  z.object({ type: z.literal("mobile"), deviceId: uuid }).strict(),
]);

export const registrationStartSchema = z
  .object({ phone, countryHint: country.optional(), locale })
  .strict();

export const registrationCompleteSchema = z
  .object({
    challengeId: uuid,
    code: otpCode,
    phone,
    password,
    countryOfResidence: country,
    preferredLocale: locale,
    client: clientSchema,
  })
  .strict();

export const loginStartSchema = z.object({ phone, password, client: clientSchema }).strict();

export const loginCompleteSchema = z.object({ loginChallengeId: uuid, code: otpCode }).strict();

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(64) }).strict();

export const sessionIdParamsSchema = z.object({ sessionId: uuid }).strict();
export const deviceIdParamsSchema = z.object({ deviceId: uuid }).strict();

export const totpCodeSchema = z.object({ code: otpCode }).strict();

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4096);

export const passkeyRegistrationVerifySchema = z
  .object({
    challengeId: uuid,
    nickname: z.string().trim().min(1).max(60).optional(),
    response: z
      .object({
        id: base64url,
        rawId: base64url,
        type: z.literal("public-key"),
        response: z
          .object({
            clientDataJSON: base64url,
            attestationObject: base64url,
            authenticatorData: base64url.optional(),
            transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).max(7).optional(),
            publicKeyAlgorithm: z.number().int().optional(),
            publicKey: base64url.optional(),
          })
          .strict(),
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export const passkeyAuthenticationVerifySchema = z
  .object({
    challengeId: uuid,
    response: z
      .object({
        id: base64url,
        rawId: base64url,
        type: z.literal("public-key"),
        response: z
          .object({
            clientDataJSON: base64url,
            authenticatorData: base64url,
            signature: base64url,
            userHandle: base64url.optional(),
          })
          .strict(),
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();
