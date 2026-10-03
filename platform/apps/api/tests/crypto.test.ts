import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BlindIndexer,
  NormalizationError,
  normalizeAccountIdentifier,
  normalizeEmail,
  normalizePhone,
} from "../src/lib/crypto/blindIndex.js";
import { EncryptionError, FieldEncryptor, KeyringKeyProvider, fieldContext } from "../src/lib/crypto/fieldEncryption.js";
import {
  WebhookSignatureError,
  verifyHmacSignature,
  verifySharedSecretHeader,
  verifyTimestampedHmacHeader,
} from "../src/lib/crypto/webhookSignature.js";

const userId = "9b2f3c1e-8a7d-4e5f-9a1b-2c3d4e5f6a7b";

function encryptor(activeKeyId = "pii-2026-01", keys = new Map([["pii-2026-01", randomBytes(32)]])): FieldEncryptor {
  return new FieldEncryptor(new KeyringKeyProvider(activeKeyId, keys));
}

describe("chiffrement de champ (enveloppe AES-256-GCM)", () => {
  it("chiffre puis déchiffre une valeur", async () => {
    const fe = encryptor();
    const context = fieldContext("identity", "users", "first_name", userId);
    const cipher = await fe.encrypt("Aminata", context);
    expect(cipher.includes(Buffer.from("Aminata"))).toBe(false);
    await expect(fe.decrypt(cipher, context)).resolves.toBe("Aminata");
  });

  it("produit un chiffré différent à chaque appel", async () => {
    const fe = encryptor();
    const context = fieldContext("identity", "users", "first_name", userId);
    const a = await fe.encrypt("Aminata", context);
    const b = await fe.encrypt("Aminata", context);
    expect(a.equals(b)).toBe(false);
  });

  it("refuse un chiffré déplacé vers une autre ligne ou une autre colonne", async () => {
    const fe = encryptor();
    const cipher = await fe.encrypt("Aminata", fieldContext("identity", "users", "first_name", userId));
    await expect(fe.decrypt(cipher, fieldContext("identity", "users", "last_name", userId))).rejects.toThrow(EncryptionError);
    await expect(
      fe.decrypt(cipher, fieldContext("identity", "users", "first_name", "00000000-0000-4000-8000-000000000000")),
    ).rejects.toThrow(EncryptionError);
  });

  it("détecte toute altération d'un octet", async () => {
    const fe = encryptor();
    const context = fieldContext("transfers", "recipients", "account_details", userId);
    const cipher = await fe.encrypt("SN08 SN01 0015 2000 0256 7890 0000", context);
    for (const position of [cipher.length - 1, cipher.length - 20, 20]) {
      const tampered = Buffer.from(cipher);
      tampered[position] = (tampered[position] ?? 0) ^ 0x01;
      await expect(fe.decrypt(tampered, context)).rejects.toThrow(EncryptionError);
    }
  });

  it("gère la rotation : anciennes valeurs lisibles, nouvelles sous la clé active", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const context = fieldContext("identity", "users", "address", userId);
    const before = encryptor("pii-2025-01", new Map([["pii-2025-01", oldKey]]));
    const legacy = await before.encrypt("12 rue de Dakar", context);

    const after = encryptor("pii-2026-01", new Map([["pii-2025-01", oldKey], ["pii-2026-01", newKey]]));
    await expect(after.decrypt(legacy, context)).resolves.toBe("12 rue de Dakar");
    expect(after.needsRotation(legacy)).toBe(true);
    const rotated = await after.encrypt("12 rue de Dakar", context);
    expect(after.keyIdOf(rotated)).toBe("pii-2026-01");
    expect(after.needsRotation(rotated)).toBe(false);
  });

  it("refuse une clé inconnue, un format inconnu et un contexte mal formé", async () => {
    const context = fieldContext("identity", "users", "first_name", userId);
    const cipher = await encryptor().encrypt("x", context);
    await expect(encryptor().decrypt(cipher, context)).rejects.toThrow(EncryptionError);
    const badVersion = Buffer.from(cipher);
    badVersion[0] = 0x02;
    await expect(encryptor().decrypt(badVersion, context)).rejects.toThrow(/version/);
    expect(() => fieldContext("identity", "users", "first-name", userId)).toThrow(EncryptionError);
    expect(() => new KeyringKeyProvider("k", new Map([["k", randomBytes(16)]]))).toThrow(EncryptionError);
  });
});

describe("index aveugles", () => {
  const indexer = new BlindIndexer(randomBytes(32));

  it("est déterministe et séparé par domaine", () => {
    const a = indexer.compute("phone", "+221771234567");
    expect(a).toHaveLength(32);
    expect(indexer.compute("phone", "+221771234567").equals(a)).toBe(true);
    expect(indexer.compute("email", "+221771234567").equals(a)).toBe(false);
  });

  it("dépend de la clé secrète", () => {
    expect(new BlindIndexer(randomBytes(32)).compute("phone", "+33612345678").equals(indexer.compute("phone", "+33612345678"))).toBe(false);
  });

  it("normalise les numéros de téléphone en E.164", () => {
    expect(normalizePhone("77 123 45 67", "SN")).toEqual({ e164: "+221771234567", country: "SN" });
    expect(normalizePhone("+33 6 12 34 56 78")).toEqual({ e164: "+33612345678", country: "FR" });
    expect(normalizePhone("06.12.34.56.78", "FR").e164).toBe("+33612345678");
    expect(() => normalizePhone("123")).toThrow(NormalizationError);
    expect(() => normalizePhone("01 23 45 67 89", "FR")).toThrow(NormalizationError);
  });

  it("normalise e-mails et identifiants de compte", () => {
    expect(normalizeEmail("  Aminata.Diallo@Example.COM ")).toBe("aminata.diallo@example.com");
    expect(() => normalizeEmail("pas-un-email")).toThrow(NormalizationError);
    expect(normalizeAccountIdentifier("fr76 3000 6000 0112 3456 7890 189")).toBe("FR7630006000011234567890189");
    expect(() => normalizeAccountIdentifier("<script>")).toThrow(NormalizationError);
  });
});

describe("signatures de webhooks", () => {
  const rawBody = Buffer.from('{"event":"charge.succeeded","id":"evt_1"}');

  it("vérifie un HMAC hexadécimal et rejette une signature altérée", () => {
    const secret = "whsec_test";
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(() => verifyHmacSignature({ secret, rawBody, signature, algorithm: "sha256", encoding: "hex" })).not.toThrow();
    const tampered = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(() => verifyHmacSignature({ secret, rawBody, signature: tampered, algorithm: "sha256", encoding: "hex" })).toThrow(WebhookSignatureError);
    expect(() =>
      verifyHmacSignature({ secret, rawBody: Buffer.from(`${rawBody.toString()} `), signature, algorithm: "sha256", encoding: "hex" }),
    ).toThrow(WebhookSignatureError);
    expect(() => verifyHmacSignature({ secret, rawBody, signature: undefined, algorithm: "sha256", encoding: "hex" })).toThrow(/absent/);
    expect(() => verifyHmacSignature({ secret, rawBody, signature: "zz", algorithm: "sha256", encoding: "hex" })).toThrow(WebhookSignatureError);
  });

  it("vérifie le schéma horodaté t=…,v1=… et sa fenêtre anti-rejeu", () => {
    const secret = "whsec_stripe_like";
    const now = 1_790_000_000;
    const sign = (t: number): string =>
      createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
    const header = `t=${now},v1=${"0".repeat(64)},v1=${sign(now)}`;
    expect(verifyTimestampedHmacHeader({ header, secret, rawBody, toleranceSeconds: 300, nowMs: now * 1000 })).toEqual({ timestamp: now });

    const old = now - 301;
    expect(() =>
      verifyTimestampedHmacHeader({ header: `t=${old},v1=${sign(old)}`, secret, rawBody, toleranceSeconds: 300, nowMs: now * 1000 }),
    ).toThrow(expect.objectContaining({ reason: "timestamp_out_of_tolerance" }));
    // Horodatage modifié par un attaquant : la signature ne correspond plus.
    expect(() =>
      verifyTimestampedHmacHeader({ header: `t=${now},v1=${sign(now - 1)}`, secret, rawBody, toleranceSeconds: 300, nowMs: now * 1000 }),
    ).toThrow(expect.objectContaining({ reason: "invalid_signature" }));
    expect(() => verifyTimestampedHmacHeader({ header: "v1=abc", secret, rawBody, toleranceSeconds: 300 })).toThrow(WebhookSignatureError);
  });

  it("compare un secret partagé en temps constant", () => {
    expect(() => verifySharedSecretHeader("flw-secret-hash", "flw-secret-hash")).not.toThrow();
    expect(() => verifySharedSecretHeader("flw-secret-hash", "flw-secret-has")).toThrow(WebhookSignatureError);
    expect(() => verifySharedSecretHeader("flw-secret-hash", undefined)).toThrow(WebhookSignatureError);
  });
});
