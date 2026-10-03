import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Chiffrement des données personnelles champ par champ (chiffrement
 * d'enveloppe, AES-256-GCM).
 *
 * Pour chaque valeur :
 *   1. une clé de données (DEK) aléatoire de 256 bits est générée ;
 *   2. la valeur est chiffrée par la DEK (AES-256-GCM, IV aléatoire de 96 bits) ;
 *   3. la DEK est chiffrée (« enveloppée ») par la clé maîtresse active (KEK)
 *      du fournisseur de clés ;
 *   4. le contexte (table, colonne, identifiant de ligne) est lié comme
 *      données authentifiées (AAD) aux deux chiffrements : un chiffré copié
 *      dans une autre ligne ou une autre colonne est indéchiffrable.
 *
 * Format binaire (version 1) :
 *   0x01 | len(keyId) [1 o] | keyId | ivDek [12 o] | tagDek [16 o] | dekChiffrée [32 o]
 *        | ivDonnée [12 o] | tagDonnée [16 o] | donnéeChiffrée
 *
 * Le fournisseur de clés est une interface : l'implémentation par trousseau
 * (clés injectées par le gestionnaire de secrets) peut être remplacée par un
 * KMS matériel (AWS KMS, GCP KMS, Vault Transit) sans changer le format.
 */

const FORMAT_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const CONTEXT_PATTERN = /^[a-z_]+\.[a-z_]+\.[a-z_]+:[A-Za-z0-9-]{1,64}$/;

export class EncryptionError extends Error {
  override readonly name = "EncryptionError";
}

export interface WrappedKey {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

export interface KeyEncryptionProvider {
  readonly activeKeyId: string;
  wrap(dataKey: Buffer, aad: Buffer): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, aad: Buffer): Promise<Buffer>;
}

/** Fournisseur de clés à partir d'un trousseau de KEK (rotation par keyId). */
export class KeyringKeyProvider implements KeyEncryptionProvider {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    readonly activeKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    for (const [keyId, key] of keys) {
      if (key.length !== KEY_LENGTH) throw new EncryptionError(`la clé ${keyId} doit faire 32 octets`);
      if (Buffer.byteLength(keyId, "utf8") > 255) throw new EncryptionError(`identifiant de clé trop long : ${keyId}`);
    }
    if (!keys.has(activeKeyId)) throw new EncryptionError(`clé active ${activeKeyId} absente du trousseau`);
    this.keys = new Map(keys);
  }

  wrap(dataKey: Buffer, aad: Buffer): Promise<WrappedKey> {
    const kek = this.requireKey(this.activeKeyId);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve({ keyId: this.activeKeyId, iv, tag: cipher.getAuthTag(), ciphertext });
  }

  unwrap(wrapped: WrappedKey, aad: Buffer): Promise<Buffer> {
    const kek = this.requireKey(wrapped.keyId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", kek, wrapped.iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(aad);
      decipher.setAuthTag(wrapped.tag);
      return Promise.resolve(Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]));
    } catch (error: unknown) {
      return Promise.reject(new EncryptionError("clé de données indéchiffrable (clé, contexte ou intégrité)", { cause: error }));
    }
  }

  private requireKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (key === undefined) throw new EncryptionError(`clé de chiffrement inconnue : ${keyId}`);
    return key;
  }
}

/**
 * Contexte de chiffrement : « schéma.table.colonne:identifiantLigne ».
 * Exemple : fieldContext("identity", "users", "phone", userId).
 */
export function fieldContext(schema: string, table: string, column: string, rowId: string): string {
  const context = `${schema}.${table}.${column}:${rowId}`;
  if (!CONTEXT_PATTERN.test(context)) throw new EncryptionError(`contexte de chiffrement invalide : ${context}`);
  return context;
}

export class FieldEncryptor {
  constructor(private readonly provider: KeyEncryptionProvider) {}

  async encrypt(plaintext: string, context: string): Promise<Buffer> {
    if (!CONTEXT_PATTERN.test(context)) throw new EncryptionError(`contexte de chiffrement invalide : ${context}`);
    const data = Buffer.from(plaintext, "utf8");
    if (data.length > MAX_PLAINTEXT_BYTES) throw new EncryptionError("valeur trop volumineuse pour un chiffrement de champ");

    const aad = Buffer.from(context, "utf8");
    const dataKey = randomBytes(KEY_LENGTH);
    try {
      const wrapped = await this.provider.wrap(dataKey, aad);
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv, { authTagLength: TAG_LENGTH });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      const keyIdBytes = Buffer.from(wrapped.keyId, "utf8");
      return Buffer.concat([
        Buffer.from([FORMAT_VERSION, keyIdBytes.length]),
        keyIdBytes,
        wrapped.iv,
        wrapped.tag,
        wrapped.ciphertext,
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ]);
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(payload: Buffer, context: string): Promise<string> {
    if (!CONTEXT_PATTERN.test(context)) throw new EncryptionError(`contexte de chiffrement invalide : ${context}`);
    const parsed = parseEnvelope(payload);
    const aad = Buffer.from(context, "utf8");
    const dataKey = await this.provider.unwrap(parsed.wrappedKey, aad);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, parsed.iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(aad);
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
    } catch (error: unknown) {
      throw new EncryptionError("donnée indéchiffrable (contexte ou intégrité)", { cause: error });
    } finally {
      dataKey.fill(0);
    }
  }

  /** Identifiant de la KEK ayant protégé une valeur (pilotage de la rotation). */
  keyIdOf(payload: Buffer): string {
    return parseEnvelope(payload).wrappedKey.keyId;
  }

  /** Vrai si la valeur doit être rechiffrée avec la clé active. */
  needsRotation(payload: Buffer): boolean {
    return this.keyIdOf(payload) !== this.provider.activeKeyId;
  }
}

interface ParsedEnvelope {
  readonly wrappedKey: WrappedKey;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

function parseEnvelope(payload: Buffer): ParsedEnvelope {
  if (payload.length < 2) throw new EncryptionError("chiffré tronqué");
  const version = payload.readUInt8(0);
  if (version !== FORMAT_VERSION) throw new EncryptionError(`version de format inconnue : ${version}`);
  const keyIdLength = payload.readUInt8(1);
  const minimumLength = 2 + keyIdLength + IV_LENGTH + TAG_LENGTH + KEY_LENGTH + IV_LENGTH + TAG_LENGTH;
  if (keyIdLength === 0 || payload.length < minimumLength) throw new EncryptionError("chiffré tronqué");

  let offset = 2;
  const take = (length: number): Buffer => {
    const slice = payload.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const keyId = take(keyIdLength).toString("utf8");
  const wrappedKey: WrappedKey = { keyId, iv: take(IV_LENGTH), tag: take(TAG_LENGTH), ciphertext: take(KEY_LENGTH) };
  const iv = take(IV_LENGTH);
  const tag = take(TAG_LENGTH);
  const ciphertext = payload.subarray(offset);
  return { wrappedKey, iv, tag, ciphertext };
}
