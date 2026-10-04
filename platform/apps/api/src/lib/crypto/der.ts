/**
 * Encodage et lecture DER (ASN.1) minimaux, suffisants pour les structures
 * RFC 3161 / CMS manipulées par l'API. Le lecteur est défensif : longueurs
 * bornées, aucune lecture hors du tampon, formes indéfinies refusées (DER).
 */

export class DerError extends Error {
  override readonly name = "DerError";
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  GENERALIZED_TIME: 0x18,
  CONTEXT_0: 0xa0,
  CONTEXT_1: 0xa1,
} as const;

// ---------------------------------------------------------------------------
// Encodage
// ---------------------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function sequence(...items: readonly Buffer[]): Buffer {
  return tlv(TAG.SEQUENCE, Buffer.concat(items));
}

export function integer(value: bigint): Buffer {
  if (value < 0n) throw new DerError("entiers négatifs non supportés");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.INTEGER, bytes);
}

export function booleanValue(value: boolean): Buffer {
  return tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

export function nullValue(): Buffer {
  return Buffer.from([TAG.NULL, 0x00]);
}

export function octetString(value: Buffer): Buffer {
  return tlv(TAG.OCTET_STRING, value);
}

export function objectIdentifier(oid: string): Buffer {
  const arcs = oid.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new DerError(`OID invalide : ${oid}`);
    return BigInt(part);
  });
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined) throw new DerError(`OID invalide : ${oid}`);
  const bytes: number[] = [];
  for (const arc of [first * 40n + second, ...rest]) {
    const chunk: number[] = [Number(arc & 0x7fn)];
    let remaining = arc >> 7n;
    while (remaining > 0n) {
      chunk.unshift(Number((remaining & 0x7fn) | 0x80n));
      remaining >>= 7n;
    }
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export interface DerNode {
  readonly tag: number;
  /** Octets complets de l'élément (en-tête compris). */
  readonly raw: Buffer;
  /** Contenu (sans en-tête). */
  readonly content: Buffer;
}

const MAX_ELEMENT_LENGTH = 1 << 20;

export function readNode(buffer: Buffer, offset = 0): { readonly node: DerNode; readonly next: number } {
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  if (tag === undefined || first === undefined) throw new DerError("DER tronqué");
  if ((tag & 0x1f) === 0x1f) throw new DerError("étiquettes longues non supportées");
  let length: number;
  let cursor = offset + 2;
  if (first < 0x80) {
    length = first;
  } else {
    const octets = first & 0x7f;
    if (octets === 0) throw new DerError("longueur indéfinie interdite en DER");
    if (octets > 4) throw new DerError("longueur DER excessive");
    length = 0;
    for (let index = 0; index < octets; index += 1) {
      const byte = buffer[cursor];
      if (byte === undefined) throw new DerError("DER tronqué");
      length = length * 256 + byte;
      cursor += 1;
    }
  }
  if (length > MAX_ELEMENT_LENGTH) throw new DerError("élément DER trop volumineux");
  const end = cursor + length;
  if (end > buffer.length) throw new DerError("DER tronqué");
  return { node: { tag, raw: buffer.subarray(offset, end), content: buffer.subarray(cursor, end) }, next: end };
}

/** Éléments contenus dans un élément construit (SEQUENCE, SET, [n]). */
export function children(node: DerNode): readonly DerNode[] {
  if ((node.tag & 0x20) === 0) throw new DerError(`l'élément 0x${node.tag.toString(16)} n'est pas construit`);
  const items: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, next } = readNode(node.content, offset);
    items.push(child);
    offset = next;
  }
  return items;
}

export function parseDer(buffer: Buffer): DerNode {
  const { node, next } = readNode(buffer, 0);
  if (next !== buffer.length) throw new DerError("octets superflus après l'élément DER");
  return node;
}

export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (node?.tag !== tag) {
    throw new DerError(`${what} : étiquette 0x${tag.toString(16)} attendue, 0x${(node?.tag ?? 0).toString(16)} trouvée`);
  }
  return node;
}

export function decodeOid(node: DerNode): string {
  expectTag(node, TAG.OID, "OID");
  const bytes = node.content;
  if (bytes.length === 0) throw new DerError("OID vide");
  const arcs: bigint[] = [];
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0n;
    }
  }
  const [first, ...rest] = arcs;
  if (first === undefined) throw new DerError("OID illisible");
  const head = first < 80n ? [first / 40n, first % 40n] : [2n, first - 80n];
  return [...head, ...rest].map(String).join(".");
}

export function decodeInteger(node: DerNode): bigint {
  expectTag(node, TAG.INTEGER, "INTEGER");
  if (node.content.length === 0) throw new DerError("INTEGER vide");
  if ((node.content[0] ?? 0) & 0x80) throw new DerError("INTEGER négatif inattendu");
  return BigInt(`0x${node.content.toString("hex")}`);
}

/** GeneralizedTime « AAAAMMJJHHMMSS[.fff]Z ». */
export function decodeGeneralizedTime(node: DerNode): Date {
  expectTag(node, TAG.GENERALIZED_TIME, "GeneralizedTime");
  const text = node.content.toString("ascii");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{1,6})?Z$/.exec(text);
  if (match === null) throw new DerError(`GeneralizedTime invalide : ${text}`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const milliseconds = fraction === undefined ? 0 : Math.floor(Number(`0${fraction}`) * 1000);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds));
}
