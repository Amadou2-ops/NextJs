/**
 * Arithmétique monétaire exacte.
 *
 * - Un montant est un entier `bigint` en unités mineures de sa devise
 *   (100,00 EUR = 10000n ; 100 JPY = 100n). Jamais de `number` flottant.
 * - Les taux de change sont des décimaux exacts (chaînes), manipulés sous
 *   forme coefficient entier + échelle.
 * - Les règles d'arrondi reproduisent EXACTEMENT celles de la base
 *   (fx.convert_minor, fx.quotes_validate, transfers.compute_fee) : un devis
 *   calculé par l'API est toujours accepté par les contrôles de la base.
 */

declare const currencyCodeBrand: unique symbol;
export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]{0,17})$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,15})?$/;

/** Plafond par montant : identique au plafond par écriture du registre (10^15). */
export const MAX_MINOR_AMOUNT = 1_000_000_000_000_000n;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

export function parseCurrencyCode(value: string): CurrencyCode {
  if (!CURRENCY_PATTERN.test(value)) throw new MoneyError(`code devise invalide : ${value}`);
  return value as CurrencyCode;
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return CURRENCY_PATTERN.test(value);
}

export interface MoneyJson {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export type Rounding = "floor" | "ceil";

export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: CurrencyCode,
  ) {}

  static ofMinor(amountMinor: bigint, currency: CurrencyCode): Money {
    if (amountMinor < 0n) throw new MoneyError("un montant ne peut pas être négatif");
    if (amountMinor > MAX_MINOR_AMOUNT) throw new MoneyError("montant au-delà du plafond autorisé");
    return new Money(amountMinor, currency);
  }

  /** Analyse un montant reçu en chaîne d'entier (format du contrat d'API). */
  static parseMinor(amount: string, currency: string): Money {
    if (!MINOR_UNITS_PATTERN.test(amount)) {
      throw new MoneyError("montant attendu : entier positif en unités mineures, transmis en chaîne");
    }
    return Money.ofMinor(BigInt(amount), parseCurrencyCode(currency));
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.amountMinor > this.amountMinor) {
      throw new MoneyError("soustraction impossible : résultat négatif");
    }
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinor === other.amountMinor) return 0;
    return this.amountMinor < other.amountMinor ? -1 : 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  /** Part proportionnelle en points de base (1 bp = 0,01 %), arrondie au choix. */
  basisPoints(bps: number, rounding: Rounding): Money {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new MoneyError("points de base attendus entre 0 et 10000");
    }
    const numerator = this.amountMinor * BigInt(bps);
    return Money.ofMinor(divideRounded(numerator, 10_000n, rounding), this.currency);
  }

  min(other: Money): Money {
    return this.compare(other) <= 0 ? this : other;
  }

  max(other: Money): Money {
    return this.compare(other) >= 0 ? this : other;
  }

  toJSON(): MoneyJson {
    return { amount: this.amountMinor.toString(), currency: this.currency };
  }

  toString(): string {
    return `${this.amountMinor.toString()} ${this.currency} (unités mineures)`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new MoneyError(`opération entre devises différentes : ${this.currency} / ${other.currency}`);
    }
  }
}

function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (numerator < 0n || denominator <= 0n) throw new MoneyError("division monétaire hors domaine");
  const quotient = numerator / denominator;
  if (rounding === "ceil" && quotient * denominator !== numerator) return quotient + 1n;
  return quotient;
}

/** Décimal exact : valeur = coefficient / 10^scale. */
export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseDecimal(value: string): ExactDecimal {
  if (!DECIMAL_PATTERN.test(value)) throw new MoneyError(`décimal invalide : ${value}`);
  const [integerPart = "0", fractionPart = ""] = value.split(".");
  return { coefficient: BigInt(integerPart + fractionPart), scale: fractionPart.length };
}

export function formatDecimal(decimal: ExactDecimal): string {
  if (decimal.scale === 0) return decimal.coefficient.toString();
  const digits = decimal.coefficient.toString().padStart(decimal.scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - decimal.scale);
  const fractionPart = digits.slice(digits.length - decimal.scale).replace(/0+$/, "");
  return fractionPart.length === 0 ? integerPart : `${integerPart}.${fractionPart}`;
}

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) throw new MoneyError("exposant invalide");
  return 10n ** BigInt(exponent);
}

/**
 * Convertit un montant en unités mineures au taux donné, arrondi vers le bas.
 * Identique à fx.convert_minor :
 *   floor(montant × taux × 10^(exposantCible − exposantSource))
 */
export function convertMinor(
  amountMinor: bigint,
  rate: string,
  sourceMinorUnits: number,
  targetMinorUnits: number,
): bigint {
  if (amountMinor < 0n) throw new MoneyError("montant négatif");
  const decimal = parseDecimal(rate);
  if (decimal.coefficient === 0n) throw new MoneyError("taux nul");
  const shift = targetMinorUnits - sourceMinorUnits;
  const numerator = amountMinor * decimal.coefficient * pow10(Math.max(0, shift));
  const denominator = pow10(decimal.scale) * pow10(Math.max(0, -shift));
  return numerator / denominator;
}

/**
 * Taux client = taux moyen × (10000 − marge) / 10000, arrondi à 15 décimales
 * au plus proche (moitié vers le haut), comme round(…, 15) de PostgreSQL pour
 * un nombre positif.
 */
export function applyMarginToRate(midRate: string, marginBps: number): string {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 1500) {
    throw new MoneyError("marge attendue entre 0 et 1500 points de base");
  }
  const mid = parseDecimal(midRate);
  const targetScale = 15;
  const numerator = mid.coefficient * BigInt(10_000 - marginBps) * pow10(targetScale);
  const denominator = pow10(mid.scale) * 10_000n;
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return formatDecimal({ coefficient: quotient, scale: targetScale });
}

/** Taux croisé source→cible à partir de deux taux contre une devise pivot (USD). */
export function crossRate(pivotToSource: string, pivotToTarget: string, scale = 15): string {
  const source = parseDecimal(pivotToSource);
  const target = parseDecimal(pivotToTarget);
  if (source.coefficient === 0n) throw new MoneyError("taux pivot nul");
  // (t / 10^ts) / (s / 10^ss) = t × 10^ss / (s × 10^ts), arrondi à `scale` décimales.
  const numerator = target.coefficient * pow10(source.scale) * pow10(scale);
  const denominator = source.coefficient * pow10(target.scale);
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return formatDecimal({ coefficient: quotient, scale });
}

/** Affichage localisé (interface uniquement, jamais pour un calcul). */
export function formatMoney(money: Money, minorUnits: number, locale: string): string {
  const divisor = pow10(minorUnits);
  const integerPart = money.amountMinor / divisor;
  const fractionPart = money.amountMinor % divisor;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  });
  const decimalString =
    minorUnits === 0 ? integerPart.toString() : `${integerPart.toString()}.${fractionPart.toString().padStart(minorUnits, "0")}`;
  return formatter.format(decimalString as Intl.StringNumericLiteral);
}

/**
 * Normalise un littéral numérique JSON (texte source exact, notation
 * scientifique admise) en décimal positif d'au plus `maxScale` décimales,
 * arrondi au plus proche (moitié vers le haut). Refuse zéro, les négatifs et
 * les valeurs hors de numeric(30, 15).
 *   "655.957" → "655.957" ; "1.23E-7" → "0.000000123" ; "1e3" → "1000"
 */
export function normalizeDecimalLiteral(source: string, maxScale = 15): string {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(source.trim());
  if (match === null) throw new MoneyError(`littéral décimal invalide : ${source}`);
  const [, integerDigits = "0", fractionDigits = "", exponentText] = match;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  // valeur = coefficient × 10^(exponent − scale)
  let coefficient = BigInt(integerDigits + fractionDigits);
  let scale = fractionDigits.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (scale > maxScale) {
    const divisor = 10n ** BigInt(scale - maxScale);
    const quotient = coefficient / divisor;
    coefficient = (coefficient % divisor) * 2n >= divisor ? quotient + 1n : quotient;
    scale = maxScale;
  }
  if (coefficient === 0n) throw new MoneyError(`taux nul ou trop petit : ${source}`);
  const formatted = formatDecimal({ coefficient, scale });
  // Contrôle de domaine (≤ 15 chiffres entiers) par l'analyseur strict.
  parseDecimal(formatted);
  return formatted;
}

/** Écart relatif |a − b| / b en points de base (arrondi supérieur). */
export function relativeDifferenceBps(a: string, b: string): number {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (right.coefficient === 0n) throw new MoneyError("référence nulle");
  const scale = Math.max(left.scale, right.scale);
  const leftScaled = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightScaled = right.coefficient * 10n ** BigInt(scale - right.scale);
  const difference = leftScaled > rightScaled ? leftScaled - rightScaled : rightScaled - leftScaled;
  const numerator = difference * 10_000n;
  const bps = numerator / rightScaled + (numerator % rightScaled === 0n ? 0n : 1n);
  return bps > 1_000_000n ? 1_000_000 : Number(bps);
}

/**
 * Montant source minimal (unités mineures) tel que convertMinor(source) ≥
 * cible : sert au mode « montant reçu » (le bénéficiaire reçoit au moins le
 * montant demandé).
 */
export function minimalSourceForTarget(targetMinor: bigint, rate: string, sourceMinorUnits: number, targetMinorUnits: number): bigint {
  if (targetMinor <= 0n) throw new MoneyError("montant cible invalide");
  const decimal = parseDecimal(rate);
  if (decimal.coefficient === 0n) throw new MoneyError("taux nul");
  // source ≥ cible × 10^(su − tu) / taux = cible × 10^scale × 10^(su − tu) / coefficient
  const shift = sourceMinorUnits - targetMinorUnits;
  const numerator = targetMinor * pow10(decimal.scale) * pow10(Math.max(0, shift));
  const denominator = decimal.coefficient * pow10(Math.max(0, -shift));
  let source = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  while (convertMinor(source, rate, sourceMinorUnits, targetMinorUnits) < targetMinor) source += 1n;
  while (source > 1n && convertMinor(source - 1n, rate, sourceMinorUnits, targetMinorUnits) >= targetMinor) source -= 1n;
  return source;
}

/**
 * Montant en unités mineures → décimal exact en unités principales
 * (10199 EUR, 2 décimales → "101.99" ; 64611 XOF, 0 décimale → "64611").
 */
export function minorToDecimalString(amountMinor: bigint, minorUnits: number): string {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) throw new MoneyError("nombre de décimales invalide");
  if (amountMinor < 0n) throw new MoneyError("montant négatif");
  if (minorUnits === 0) return amountMinor.toString();
  const divisor = pow10(minorUnits);
  return `${(amountMinor / divisor).toString()}.${(amountMinor % divisor).toString().padStart(minorUnits, "0")}`;
}

/**
 * Décimal en unités principales (texte exact, ex. lu sans perte dans un JSON)
 * → unités mineures. Refuse toute précision supérieure à la devise : un
 * montant prestataire « 101.995 EUR » n'est jamais arrondi silencieusement.
 */
export function decimalStringToMinor(value: string, minorUnits: number): bigint {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) throw new MoneyError("nombre de décimales invalide");
  const match = /^(\d{1,18})(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) throw new MoneyError(`montant décimal invalide : ${value}`);
  const integerPart = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > minorUnits) throw new MoneyError(`montant plus précis que la devise : ${value}`);
  return BigInt(integerPart) * pow10(minorUnits) + BigInt(fraction.padEnd(minorUnits, "0") || "0");
}

/** Comme decimalStringToMinor, mais arrondi au supérieur (frais prestataire plus précis que la devise). */
export function decimalStringToMinorCeil(value: string, minorUnits: number): bigint {
  const match = /^(\d{1,18})(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) throw new MoneyError(`montant décimal invalide : ${value}`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length <= minorUnits) return decimalStringToMinor(value, minorUnits);
  const kept = fraction.slice(0, minorUnits);
  const truncated = decimalStringToMinor(`${match[1] ?? "0"}${kept.length > 0 ? `.${kept}` : ""}`, minorUnits);
  return truncated + 1n;
}
