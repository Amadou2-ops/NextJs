import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type { Request } from "express";

import type { DatabasePool } from "../../db/pool.js";
import { AppError } from "../../lib/errors.js";

/**
 * Signature des requêtes par la clé matérielle de l'appareil (Secure Enclave,
 * StrongBox). Elle prouve, à chaque requête sensible, la possession de
 * l'appareil enregistré : un jeton d'accès volé est inutilisable ailleurs.
 *
 * En-têtes :
 *   X-Device-Id                    identifiant de l'appareil
 *   X-Device-Signature-Timestamp   horodatage Unix en millisecondes
 *   X-Device-Counter               compteur strictement croissant (anti-rejeu)
 *   X-Device-Signature             signature base64url (ES256 au format DER, ou EdDSA)
 *
 * Message signé (UTF-8) :
 *   "TPv1\n" + MÉTHODE + "\n" + chemin?requête + "\n" + horodatage + "\n"
 *   + compteur + "\n" + base64url(SHA-256(corps brut))
 */

const TIMESTAMP_TOLERANCE_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DeviceSignatureError extends AppError {
  override readonly name = "DeviceSignatureError";
  constructor(reason: string) {
    super("DEVICE_SIGNATURE_INVALID", 401, "Signature d'appareil invalide", {
      detail: "La requête doit être signée par un appareil de confiance.",
      internalContext: { reason },
    });
  }
}

export interface SignedRequestParts {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly rawBody: Buffer;
  readonly deviceId: string | undefined;
  readonly timestamp: string | undefined;
  readonly counter: string | undefined;
  readonly signature: string | undefined;
}

export function signedRequestParts(req: Request): SignedRequestParts {
  return {
    method: req.method,
    pathWithQuery: req.originalUrl,
    rawBody: req.rawBody ?? Buffer.alloc(0),
    deviceId: req.get("x-device-id"),
    timestamp: req.get("x-device-signature-timestamp"),
    counter: req.get("x-device-counter"),
    signature: req.get("x-device-signature"),
  };
}

export function canonicalSigningMessage(parts: {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly timestamp: string;
  readonly counter: string;
  readonly rawBody: Buffer;
}): Buffer {
  const bodyHash = createHash("sha256").update(parts.rawBody).digest("base64url");
  return Buffer.from(
    `TPv1\n${parts.method.toUpperCase()}\n${parts.pathWithQuery}\n${parts.timestamp}\n${parts.counter}\n${bodyHash}`,
    "utf8",
  );
}

/** Importe et contrôle une clé publique d'appareil (SPKI DER). */
export function importDevicePublicKey(spki: Buffer, algorithm: "ES256" | "EdDSA"): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch (error: unknown) {
    throw new AppError("VALIDATION_FAILED", 400, "Clé d'appareil invalide", { detail: "Clé publique d'appareil illisible.", cause: error });
  }
  const valid =
    algorithm === "ES256"
      ? key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      : key.asymmetricKeyType === "ed25519";
  if (!valid) {
    throw new AppError("VALIDATION_FAILED", 400, "Clé d'appareil invalide", {
      detail: "Type de clé incompatible avec l'algorithme déclaré (ES256 : P-256, EdDSA : Ed25519).",
    });
  }
  return key;
}

interface DeviceKeyRow {
  user_id: string;
  public_key_spki: Buffer;
  public_key_algorithm: "ES256" | "EdDSA";
  revoked_at: Date | null;
  trusted_at: Date | null;
}

export class DeviceBindingService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Vérifie la signature d'une requête pour l'appareil attendu (ou celui
   * annoncé par l'en-tête si aucun n'est imposé) et avance son compteur de
   * façon atomique. Renvoie l'appareil et son propriétaire.
   */
  async verify(parts: SignedRequestParts, expected: { readonly deviceId?: string; readonly userId?: string } = {}): Promise<{ readonly deviceId: string; readonly userId: string }> {
    const deviceId = parts.deviceId;
    if (deviceId === undefined || !UUID_PATTERN.test(deviceId)) throw new DeviceSignatureError("missing_device_id");
    if (expected.deviceId !== undefined && expected.deviceId !== deviceId) throw new DeviceSignatureError("device_mismatch");
    if (parts.timestamp === undefined || !/^\d{13}$/.test(parts.timestamp)) throw new DeviceSignatureError("missing_timestamp");
    if (Math.abs(this.now() - Number(parts.timestamp)) > TIMESTAMP_TOLERANCE_MS) throw new DeviceSignatureError("timestamp_out_of_tolerance");
    if (parts.counter === undefined || !/^[1-9]\d{0,15}$/.test(parts.counter)) throw new DeviceSignatureError("missing_counter");
    if (parts.signature === undefined || !/^[A-Za-z0-9_-]{40,200}$/.test(parts.signature)) throw new DeviceSignatureError("missing_signature");

    const result = await this.pool.query<DeviceKeyRow>(
      `SELECT user_id, public_key_spki, public_key_algorithm, revoked_at, trusted_at
         FROM identity.devices WHERE id = $1`,
      [deviceId],
    );
    const device = result.rows[0];
    if (device?.revoked_at !== null || device.trusted_at === null) throw new DeviceSignatureError("unknown_or_revoked_device");
    if (expected.userId !== undefined && expected.userId !== device.user_id) throw new DeviceSignatureError("device_of_other_user");

    const key = importDevicePublicKey(device.public_key_spki, device.public_key_algorithm);
    const message = canonicalSigningMessage({
      method: parts.method,
      pathWithQuery: parts.pathWithQuery,
      timestamp: parts.timestamp,
      counter: parts.counter,
      rawBody: parts.rawBody,
    });
    const signature = Buffer.from(parts.signature, "base64url");
    const valid =
      device.public_key_algorithm === "ES256"
        ? verifySignature("sha256", message, { key, dsaEncoding: "der" }, signature)
        : verifySignature(null, message, key, signature);
    if (!valid) throw new DeviceSignatureError("bad_signature");

    // Anti-rejeu : le compteur doit être strictement supérieur au dernier vu.
    const advanced = await this.pool.query(
      `UPDATE identity.devices SET signature_counter = $2, last_seen_at = now()
        WHERE id = $1 AND signature_counter < $2 AND revoked_at IS NULL`,
      [deviceId, parts.counter],
    );
    if (advanced.rowCount !== 1) throw new DeviceSignatureError("replayed_counter");
    return { deviceId, userId: device.user_id };
  }
}
