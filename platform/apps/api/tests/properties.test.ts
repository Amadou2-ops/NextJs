import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { parseCsv } from "../src/lib/csv.js";
import { DecimalLiteral, parseJsonPreservingNumbers, stringifyWithDecimals } from "../src/lib/json.js";
import {
  applyMarginToRate,
  convertMinor,
  decimalStringToMinor,
  decimalStringToMinorCeil,
  formatDecimal,
  minimalSourceForTarget,
  minorToDecimalString,
  Money,
  normalizeDecimalLiteral,
  parseCurrencyCode,
  parseDecimal,
  relativeDifferenceBps,
} from "../src/lib/money.js";
import { jaroWinkler, nameMatchScore, normalizeForScreening } from "../src/modules/aml/nameMatching.js";
import { createOwnerPool } from "./support/fixtures.js";

/**
 * Tests de propriétés : chaque primitive financière ou de criblage est
 * vérifiée sur des milliers d'entrées générées (fast-check), et les calculs
 * de change de l'API sont confrontés à ceux de PostgreSQL, qui fait foi.
 * Graine fixe : un échec est reproductible à l'identique.
 */

const RUNS = { numRuns: 2000, seed: 20261004 } as const;
const EUR = parseCurrencyCode("EUR");

const minorUnits = fc.integer({ min: 0, max: 4 });
const amount = fc.bigInt({ min: 0n, max: 10n ** 17n });
/** Taux positif à 1–15 décimales, partie entière ≤ 6 chiffres. */
const rate = fc
  .tuple(fc.bigInt({ min: 0n, max: 999_999n }), fc.integer({ min: 0, max: 15 }), fc.bigInt({ min: 1n, max: 10n ** 15n - 1n }))
  .map(([integer, scale, fraction]) => {
    const text = scale === 0 ? integer.toString() : `${integer.toString()}.${(fraction % 10n ** BigInt(scale)).toString().padStart(scale, "0")}`;
    return parseDecimal(text).coefficient === 0n ? "0.5" : formatDecimal(parseDecimal(text));
  });

describe("montants en unités mineures", () => {
  it("convertit unités mineures ↔ décimal sans perte", () => {
    fc.assert(
      fc.property(amount, minorUnits, (value, units) => {
        expect(decimalStringToMinor(minorToDecimalString(value, units), units)).toBe(value);
      }),
      RUNS,
    );
  });

  it("refuse toute précision supérieure à la devise et arrondit les frais au supérieur exact", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), minorUnits, fc.integer({ min: 1, max: 4 }), (fine, units, extra) => {
        // `fine` exprimé avec units + extra décimales.
        const text = minorToDecimalString(fine, units + extra > 4 ? 4 : units + extra);
        const precision = units + extra > 4 ? 4 : units + extra;
        const scale = 10n ** BigInt(precision - units);
        const exactCeil = fine / scale + (fine % scale === 0n ? 0n : 1n);
        expect(decimalStringToMinorCeil(text, units)).toBe(exactCeil);
        if (fine % scale !== 0n) expect(() => decimalStringToMinor(text, units)).toThrow();
      }),
      RUNS,
    );
  });

  it("répartit les points de base sans jamais créer d'argent", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.integer({ min: 0, max: 10_000 }), (value, bps) => {
        const money = Money.ofMinor(value, EUR);
        const floor = money.basisPoints(bps, "floor").amountMinor;
        const ceil = money.basisPoints(bps, "ceil").amountMinor;
        expect(floor <= ceil && ceil <= floor + 1n).toBe(true);
        expect(floor + money.basisPoints(10_000 - bps, "floor").amountMinor <= value).toBe(true);
        expect(ceil + money.basisPoints(10_000 - bps, "ceil").amountMinor >= value).toBe(true);
      }),
      RUNS,
    );
  });

  it("n'autorise ni montant négatif ni mélange de devises", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (a, b) => {
        const left = Money.ofMinor(a, EUR);
        const right = Money.ofMinor(b, EUR);
        if (b > a) expect(() => left.subtract(right)).toThrow();
        else expect(left.subtract(right).add(right).equals(left)).toBe(true);
        expect(() => left.add(Money.ofMinor(b, parseCurrencyCode("XOF")))).toThrow();
      }),
      RUNS,
    );
  });
});

describe("change", () => {
  it("arrondit toujours en faveur de la plateforme (conversion sous-additive, au plus 1 unité d'écart)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 7n }), fc.bigInt({ min: 0n, max: 10n ** 7n }), rate, minorUnits, minorUnits, (a, b, r, su, tu) => {
        // Hors du plafond de la plateforme, la conversion est refusée (testé avec la parité SQL).
        fc.pre(withinCeiling(() => convertMinor(a + b, r, su, tu)));
        const whole = convertMinor(a + b, r, su, tu);
        const parts = convertMinor(a, r, su, tu) + convertMinor(b, r, su, tu);
        expect(whole >= parts && whole <= parts + 1n).toBe(true);
      }),
      RUNS,
    );
  });

  it("trouve le montant source minimal garantissant le montant reçu", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), rate.filter((value) => !parseDecimalValueLess(value, "0.00001")), minorUnits, minorUnits, (target, r, su, tu) => {
        fc.pre(withinCeiling(() => minimalSourceForTarget(target, r, su, tu)));
        const source = minimalSourceForTarget(target, r, su, tu);
        expect(convertMinor(source, r, su, tu) >= target).toBe(true);
        if (source > 1n) expect(convertMinor(source - 1n, r, su, tu) < target).toBe(true);
      }),
      { ...RUNS, numRuns: 500 },
    );
  });

  it("applique une marge qui ne dépasse jamais le taux moyen et croît avec les points de base", () => {
    // Taux réalistes (≥ 0,00001) : à 15 décimales, l'arrondi reste négligeable devant 1 point de base.
    const realisticRate = rate.filter((value) => !parseDecimalValueLess(value, "0.00001"));
    fc.assert(
      fc.property(realisticRate, fc.integer({ min: 0, max: 1499 }), (mid, margin) => {
        const lower = applyMarginToRate(mid, margin + 1);
        const higher = applyMarginToRate(mid, margin);
        expect(relativeDifferenceBps(higher, mid) <= margin + 1).toBe(true);
        expect(parseDecimalValueLess(lower, higher) || lower === higher).toBe(true);
        expect(parseDecimalValueLess(mid, higher)).toBe(false);
      }),
      RUNS,
    );
  });

  it("normalise les littéraux JSON (notation scientifique comprise) sans perte", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 18n }), fc.integer({ min: 0, max: 15 }), (coefficient, scale) => {
        const plain = formatDecimal({ coefficient, scale });
        if (parseDecimalSafe(plain) === null) return;
        expect(normalizeDecimalLiteral(plain)).toBe(plain);
        const scientific = `${coefficient.toString()}E-${scale.toString()}`;
        expect(normalizeDecimalLiteral(scientific)).toBe(plain);
        expect(relativeDifferenceBps(plain, plain)).toBe(0);
      }),
      RUNS,
    );
  });
});

describe("JSON sans flottants", () => {
  it("relit chaque montant au texte exact et le réécrit à l'identique", () => {
    const decimalText = fc
      .tuple(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 20 }))
      .map(([coefficient, scale]) => formatDecimal({ coefficient, scale }));
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), decimalText, { minKeys: 1, maxKeys: 8 }), (values) => {
        const json = stringifyWithDecimals(Object.fromEntries(Object.entries(values).map(([key, text]) => [key, new DecimalLiteral(text)])));
        expect(parseJsonPreservingNumbers(json)).toEqual(values);
      }),
      RUNS,
    );
  });
});

describe("rapprochement de noms et CSV", () => {
  const name = fc.stringMatching(/^[A-Za-zÀ-ÿ' -]{1,40}$/);

  it("calcule une similarité bornée, symétrique et maximale pour un nom identique", () => {
    fc.assert(
      fc.property(name, name, (a, b) => {
        const score = jaroWinkler(a, b);
        expect(score >= 0 && score <= 1).toBe(true);
        expect(jaroWinkler(b, a)).toBeCloseTo(score, 12);
        expect(jaroWinkler(a, a)).toBe(a.length === 0 ? jaroWinkler(a, a) : 1);
      }),
      RUNS,
    );
  });

  it("ignore l'ordre des noms, la casse et les accents", () => {
    const token = fc.stringMatching(/^[a-z]{3,10}$/);
    fc.assert(
      fc.property(fc.array(token, { minLength: 2, maxLength: 4 }), (tokens) => {
        const reversed = [...tokens].reverse().join(" ").toUpperCase();
        expect(normalizeForScreening(reversed)).toBe(normalizeForScreening(tokens.join(" ")));
        expect(nameMatchScore(tokens.join(" "), reversed)).toBe(1);
      }),
      RUNS,
    );
  });

  it("relit à l'identique tout CSV correctement échappé", () => {
    const field = fc.string({ maxLength: 20 }).filter((value) => !value.includes("\r"));
    fc.assert(
      fc.property(fc.array(fc.array(field, { minLength: 2, maxLength: 5 }), { minLength: 1, maxLength: 10 }), (rows) => {
        const text = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
        expect(parseCsv(text)).toEqual(rows);
      }),
      RUNS,
    );
  });
});

describe("parité avec PostgreSQL (la base fait foi)", () => {
  const owner = createOwnerPool();
  afterAll(() => owner.end());

  it("convertit exactement comme fx.convert_minor et applique la marge comme fx.quotes_validate", async () => {
    const currencies = [
      ["EUR", 2],
      ["XOF", 0],
      ["BHD", 3],
      ["JPY", 0],
      ["USD", 2],
    ] as const;
    const samples = fc.sample(
      fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 9n }), rate, fc.constantFrom(...currencies), fc.constantFrom(...currencies), fc.integer({ min: 0, max: 1500 })),
      { numRuns: 1000, seed: RUNS.seed },
    ).filter(([value, r, source, target]) => {
      // Hors plafond, l'API refuse (vérifié ci-dessous) ; la parité porte sur le domaine valide.
      try {
        convertMinor(value, r, source[1], target[1]);
        return true;
      } catch {
        return false;
      }
    });
    expect(samples.length).toBeGreaterThan(500);
    expect(() => convertMinor(10n ** 12n, "999999", 0, 4)).toThrow(/plafond/);
    const result = await owner.query<{ converted: string; margined: string }>(
      `SELECT fx.convert_minor(s.amount, s.rate, s.source, s.target)::text AS converted,
              trim_scale(round(s.rate * (10000 - s.margin)::numeric * 0.0001, 15))::text AS margined
         FROM jsonb_to_recordset($1::jsonb) AS s(amount bigint, rate numeric, source text, target text, margin integer, n integer)
        ORDER BY s.n`,
      [JSON.stringify(samples.map(([value, r, source, target, margin], n) => ({ amount: value.toString(), rate: r, source: source[0], target: target[0], margin, n })))],
    );
    samples.forEach(([value, r, source, target, margin], index) => {
      const row = result.rows[index];
      expect(row?.converted, `${value.toString()} ${source[0]} → ${target[0]} @ ${r}`).toBe(convertMinor(value, r, source[1], target[1]).toString());
      expect(row?.margined, `marge ${margin.toString()} sur ${r}`).toBe(applyMarginToRate(r, margin));
    });
  });
});

function withinCeiling(compute: () => bigint): boolean {
  try {
    compute();
    return true;
  } catch {
    return false;
  }
}

function parseDecimalSafe(value: string): ReturnType<typeof parseDecimal> | null {
  try {
    return parseDecimal(value);
  } catch {
    return null;
  }
}

function parseDecimalValueLess(a: string, b: string): boolean {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale) < right.coefficient * 10n ** BigInt(scale - right.scale);
}
