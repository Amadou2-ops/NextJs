import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 chiffres, pas de 30 s), compatible avec les
 * applications d'authentification courantes. Tolérance d'un pas avant/après
 * pour la dérive d'horloge ; l'anti-rejeu (un pas utilisé une seule fois) est
 * assuré en base (identity.users.mfa_totp_last_used_step).
 */

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("base32 invalide");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function timeStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / PERIOD_SECONDS);
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Vérifie un code ; renvoie le pas de temps correspondant (à enregistrer pour
 * l'anti-rejeu) ou undefined. Les pas ≤ lastUsedStep sont refusés.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { readonly nowMs?: number; readonly lastUsedStep?: number | null; readonly window?: number } = {},
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = timeStep((options.nowMs ?? Date.now()) / 1000);
  const window = options.window ?? 1;
  let matched: number | undefined;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    const expected = Buffer.from(hotp(secret, step), "utf8");
    // Parcours complet de la fenêtre, comparaison en temps constant.
    if (timingSafeEqual(expected, Buffer.from(code, "utf8")) && matched === undefined) matched = step;
  }
  if (matched === undefined) return undefined;
  if (options.lastUsedStep !== undefined && options.lastUsedStep !== null && matched <= options.lastUsedStep) return undefined;
  return matched;
}

export function totpProvisioningUri(params: { readonly secret: Buffer; readonly issuer: string; readonly accountLabel: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountLabel}`);
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
