import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { canonicalSigningMessage } from "../../src/modules/auth/deviceBinding.service.js";

/**
 * Appareil logiciel de test : paire de clés (P-256 ou Ed25519) et signature
 * des requêtes au format attendu par DeviceBindingService.
 */
export class TestDevice {
  private counter = 0;
  readonly privateKey: KeyObject;
  readonly publicKeySpki: Buffer;

  constructor(readonly algorithm: "ES256" | "EdDSA" = "ES256") {
    const pair = algorithm === "ES256" ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicKeySpki = pair.publicKey.export({ type: "spki", format: "der" });
  }

  nextCounter(): number {
    this.counter += 1;
    return this.counter;
  }

  signatureHeaders(params: {
    readonly deviceId: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly counter?: number;
    readonly timestampMs?: number;
  }): Record<string, string> {
    const rawBody = params.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(params.body), "utf8");
    const timestamp = String(params.timestampMs ?? Date.now());
    const counter = String(params.counter ?? this.nextCounter());
    const message = canonicalSigningMessage({ method: params.method, pathWithQuery: params.path, timestamp, counter, rawBody });
    const signature =
      this.algorithm === "ES256"
        ? sign("sha256", message, { key: this.privateKey, dsaEncoding: "der" })
        : sign(null, message, this.privateKey);
    return {
      "X-Device-Id": params.deviceId,
      "X-Device-Signature-Timestamp": timestamp,
      "X-Device-Counter": counter,
      "X-Device-Signature": signature.toString("base64url"),
    };
  }
}
