import { createHmac } from "node:crypto";

import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { CountryCode } from "libphonenumber-js/max";

/**
 * Index aveugles : HMAC-SHA-256 d'une valeur normalisée, avec une clé secrète
 * distincte des clés de chiffrement. Ils permettent la recherche exacte
 * (connexion par téléphone, détection de doublons) sans stocker la valeur.
 *
 * Chaque domaine (téléphone, e-mail, coordonnées bancaires, numéro de pièce)
 * est séparé : deux valeurs identiques dans deux domaines produisent des index
 * différents, ce qui empêche toute corrélation croisée.
 */

export type BlindIndexDomain =
  | "phone"
  | "email"
  | "otp_destination"
  | "recipient_account"
  | "document_number";

export class NormalizationError extends Error {
  override readonly name = "NormalizationError";
}

export class BlindIndexer {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("la clé d'index aveugle doit faire 32 octets");
  }

  /** Calcule l'index d'une valeur DÉJÀ normalisée (32 octets). */
  compute(domain: BlindIndexDomain, normalizedValue: string): Buffer {
    return createHmac("sha256", this.key)
      .update(`transfertplus/blind-index/v1/${domain}`, "utf8")
      .update(Buffer.from([0]))
      .update(normalizedValue, "utf8")
      .digest();
  }
}

/**
 * Normalise un numéro de téléphone au format E.164. Le pays par défaut sert à
 * interpréter un numéro national ; le numéro doit être valide (plan de
 * numérotation) et mobile ou fixe/mobile.
 */
export function normalizePhone(input: string, defaultCountry?: CountryCode): { readonly e164: string; readonly country: CountryCode } {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry === undefined ? undefined : { defaultCountry });
  if (!parsed?.isValid()) throw new NormalizationError("numéro de téléphone invalide");
  const type = parsed.getType();
  if (type !== undefined && type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") {
    throw new NormalizationError("un numéro de téléphone mobile est requis");
  }
  if (parsed.country === undefined) throw new NormalizationError("pays du numéro indéterminé");
  return { e164: parsed.number, country: parsed.country };
}

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Normalise une adresse e-mail (Unicode NFKC, minuscules, sans espaces). */
export function normalizeEmail(input: string): string {
  const normalized = input.normalize("NFKC").trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new NormalizationError("adresse e-mail invalide");
  }
  return normalized;
}

/** Normalise un identifiant de compte (IBAN, numéro de compte, wallet). */
export function normalizeAccountIdentifier(input: string): string {
  const normalized = input.normalize("NFKC").replace(/[\s.-]/g, "").toUpperCase();
  if (!/^[A-Z0-9+]{4,64}$/.test(normalized)) throw new NormalizationError("identifiant de compte invalide");
  return normalized;
}
