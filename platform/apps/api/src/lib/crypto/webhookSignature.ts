import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Primitives de vérification des signatures de webhooks. Les adaptateurs par
 * prestataire (phases 6 et 7) s'appuient sur ces fonctions ; ils ne
 * comparent jamais une signature avec `===` (attaque temporelle) et vérifient
 * toujours sur le corps BRUT reçu, octet pour octet, jamais sur un JSON
 * réanalysé.
 */

export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
  constructor(
    readonly reason: "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance" | "malformed_payload",
    message: string,
  ) {
    super(message);
  }
}

export type HmacAlgorithm = "sha256" | "sha512";
export type SignatureEncoding = "hex" | "base64";

/** Comparaison en temps constant de deux chaînes encodées. */
export function constantTimeEqual(expected: Buffer, received: Buffer): boolean {
  if (expected.length !== received.length) {
    // Comparaison factice de même durée pour ne pas révéler la longueur attendue.
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, received);
}

export function computeHmac(secret: Buffer | string, payload: Buffer, algorithm: HmacAlgorithm): Buffer {
  return createHmac(algorithm, secret).update(payload).digest();
}

function decodeSignature(signature: string, encoding: SignatureEncoding): Buffer {
  const pattern = encoding === "hex" ? /^[0-9a-fA-F]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!pattern.test(signature)) {
    throw new WebhookSignatureError("invalid_signature", "signature mal encodée");
  }
  return Buffer.from(signature, encoding);
}

/** Vérifie HMAC(secret, corps brut) == signature. */
export function verifyHmacSignature(params: {
  readonly secret: Buffer | string;
  readonly rawBody: Buffer;
  readonly signature: string | undefined;
  readonly algorithm: HmacAlgorithm;
  readonly encoding: SignatureEncoding;
}): void {
  if (params.signature === undefined || params.signature.length === 0) {
    throw new WebhookSignatureError("missing_signature", "en-tête de signature absent");
  }
  const expected = computeHmac(params.secret, params.rawBody, params.algorithm);
  const received = decodeSignature(params.signature.trim(), params.encoding);
  if (!constantTimeEqual(expected, received)) {
    throw new WebhookSignatureError("invalid_signature", "signature invalide");
  }
}

/** Vérifie qu'un horodatage signé est dans la fenêtre de tolérance (anti-rejeu). */
export function assertTimestampWithinTolerance(timestampSeconds: number, toleranceSeconds: number, nowMs = Date.now()): void {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new WebhookSignatureError("malformed_payload", "horodatage de signature invalide");
  }
  const skew = Math.abs(nowMs / 1000 - timestampSeconds);
  if (skew > toleranceSeconds) {
    throw new WebhookSignatureError("timestamp_out_of_tolerance", `horodatage hors tolérance (${Math.round(skew)} s)`);
  }
}

/**
 * Schéma « horodatage + HMAC » (en-tête du type `t=<unix>,v1=<hex>[,v1=<hex>]`,
 * utilisé notamment par Stripe) : la charge signée est `${t}.${corps brut}`.
 * Plusieurs signatures v1 peuvent être présentes pendant une rotation de
 * secret ; une seule valide suffit.
 */
export function verifyTimestampedHmacHeader(params: {
  readonly header: string | undefined;
  readonly secret: string;
  readonly rawBody: Buffer;
  readonly toleranceSeconds: number;
  readonly signatureScheme?: string;
  readonly nowMs?: number;
}): { readonly timestamp: number } {
  if (params.header === undefined || params.header.length === 0) {
    throw new WebhookSignatureError("missing_signature", "en-tête de signature absent");
  }
  const scheme = params.signatureScheme ?? "v1";
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of params.header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (!/^[0-9]{1,12}$/.test(value)) throw new WebhookSignatureError("malformed_payload", "horodatage illisible");
      timestamp = Number(value);
    } else if (key === scheme) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError("missing_signature", "horodatage ou signature absents de l'en-tête");
  }
  assertTimestampWithinTolerance(timestamp, params.toleranceSeconds, params.nowMs);

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), params.rawBody]);
  const expected = computeHmac(params.secret, signedPayload, "sha256");
  const valid = signatures.some((signature) => {
    if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
    return constantTimeEqual(expected, Buffer.from(signature, "hex"));
  });
  if (!valid) throw new WebhookSignatureError("invalid_signature", "aucune signature valide");
  return { timestamp };
}

/**
 * Secret partagé envoyé tel quel dans un en-tête (schéma `verif-hash` de
 * Flutterwave) : comparaison en temps constant des empreintes SHA-256 pour
 * neutraliser toute différence de longueur.
 */
export function verifySharedSecretHeader(expectedSecret: string, receivedHeader: string | undefined): void {
  if (receivedHeader === undefined || receivedHeader.length === 0) {
    throw new WebhookSignatureError("missing_signature", "en-tête de secret absent");
  }
  const expected = createHmac("sha256", "transfertplus/shared-secret").update(expectedSecret, "utf8").digest();
  const received = createHmac("sha256", "transfertplus/shared-secret").update(receivedHeader, "utf8").digest();
  if (!timingSafeEqual(expected, received)) {
    throw new WebhookSignatureError("invalid_signature", "secret partagé invalide");
  }
}
