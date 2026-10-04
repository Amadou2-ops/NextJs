import "server-only";

import { createHash } from "node:crypto";

import { compactDecrypt, CompactEncrypt } from "jose";
import { z } from "zod";

/**
 * Scellement des cookies : JWE compact « dir » + A256GCM (chiffré et
 * authentifié). Le contenu porte son type et son expiration : un cookie d'un
 * autre usage ou expiré est refusé même s'il est intact. La première clé
 * scelle ; les suivantes ne servent qu'à lire pendant une rotation.
 */

const envelopeSchema = z.object({ typ: z.string(), exp: z.number().int(), data: z.unknown() });

export async function seal(keys: readonly Buffer[], type: string, data: unknown, expiresAt: Date): Promise<string> {
  const key = keys[0];
  if (key === undefined) throw new Error("aucune clé de scellement");
  const payload = new TextEncoder().encode(JSON.stringify({ typ: type, exp: Math.floor(expiresAt.getTime() / 1000), data }));
  return new CompactEncrypt(payload).setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: keyId(key) }).encrypt(key);
}

export async function unseal<T>(keys: readonly Buffer[], type: string, token: string, schema: z.ZodType<T>, now: Date = new Date()): Promise<T | null> {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  for (const key of keys) {
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(token, key, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
      if (protectedHeader.kid !== keyId(key)) continue;
      const envelope = envelopeSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (!envelope.success || envelope.data.typ !== type || envelope.data.exp * 1000 <= now.getTime()) return null;
      const data = schema.safeParse(envelope.data.data);
      return data.success ? data.data : null;
    } catch {
      // Clé suivante (rotation) ; un jeton altéré échoue avec toutes les clés.
    }
  }
  return null;
}

/** Identifiant non secret d'une clé : 8 premiers octets de son empreinte SHA-256. */
function keyId(key: Buffer): string {
  return createHash("sha256").update("transfertplus/session-key-id").update(key).digest().subarray(0, 8).toString("base64url");
}
