import { describe, expect, it } from "vitest";

import {
  applyMarginToRate,
  convertMinor,
  crossRate,
  formatDecimal,
  formatMoney,
  Money,
  MoneyError,
  parseCurrencyCode,
  parseDecimal,
} from "../src/lib/money.js";

const EUR = parseCurrencyCode("EUR");
const XOF = parseCurrencyCode("XOF");

describe("Money", () => {
  it("analyse un montant en unités mineures transmis en chaîne", () => {
    const money = Money.parseMinor("10000", "EUR");
    expect(money.amountMinor).toBe(10000n);
    expect(money.toJSON()).toEqual({ amount: "10000", currency: "EUR" });
  });

  it.each(["10.5", "-1", "01", "", "1e3", " 100", "100 ", "0x10", "1000000000000000000"])(
    "refuse le montant mal formé %j",
    (amount) => {
      expect(() => Money.parseMinor(amount, "EUR")).toThrow(MoneyError);
    },
  );

  it("refuse les montants au-delà du plafond du registre", () => {
    expect(() => Money.ofMinor(1_000_000_000_000_001n, EUR)).toThrow(MoneyError);
    expect(Money.ofMinor(1_000_000_000_000_000n, EUR).amountMinor).toBe(1_000_000_000_000_000n);
  });

  it("additionne et soustrait sans perte de précision", () => {
    const a = Money.ofMinor(999_999_999_999_999n, EUR);
    expect(a.add(Money.ofMinor(1n, EUR)).amountMinor).toBe(1_000_000_000_000_000n);
    expect(Money.ofMinor(10n, EUR).subtract(Money.ofMinor(3n, EUR)).amountMinor).toBe(7n);
  });

  it("interdit un résultat négatif et le mélange de devises", () => {
    expect(() => Money.ofMinor(1n, EUR).subtract(Money.ofMinor(2n, EUR))).toThrow(MoneyError);
    expect(() => Money.ofMinor(1n, EUR).add(Money.ofMinor(1n, XOF))).toThrow(MoneyError);
    expect(() => Money.ofMinor(1n, EUR).compare(Money.ofMinor(1n, XOF))).toThrow(MoneyError);
  });

  it("calcule une part en points de base avec l'arrondi demandé", () => {
    const amount = Money.ofMinor(10001n, EUR);
    expect(amount.basisPoints(150, "floor").amountMinor).toBe(150n);
    expect(amount.basisPoints(150, "ceil").amountMinor).toBe(151n);
    expect(Money.ofMinor(10000n, EUR).basisPoints(150, "ceil").amountMinor).toBe(150n);
    expect(() => amount.basisPoints(1.5, "floor")).toThrow(MoneyError);
  });

  it("refuse un code devise invalide", () => {
    expect(() => parseCurrencyCode("eur")).toThrow(MoneyError);
    expect(() => parseCurrencyCode("EURO")).toThrow(MoneyError);
  });
});

describe("taux et conversions", () => {
  it("analyse et formate les décimaux exacts", () => {
    expect(parseDecimal("655.957")).toEqual({ coefficient: 655957n, scale: 3 });
    expect(formatDecimal({ coefficient: 646117645000000000n, scale: 15 })).toBe("646.117645");
    expect(formatDecimal({ coefficient: 5n, scale: 3 })).toBe("0.005");
    expect(() => parseDecimal("1,5")).toThrow(MoneyError);
    expect(() => parseDecimal("-1")).toThrow(MoneyError);
  });

  it("convertit vers une devise sans décimales en arrondissant vers le bas", () => {
    // 100,00 EUR × 646,117645 = 64 611,7645 XOF → 64 611
    expect(convertMinor(10000n, "646.117645", 2, 0)).toBe(64611n);
  });

  it("convertit vers une devise à 2 décimales en arrondissant vers le bas", () => {
    // 64 611 XOF / 655,957 = 98,4988… EUR → 98,49
    expect(convertMinor(64611n, "0.001524490172404", 0, 2)).toBe(9849n);
  });

  it("gère les devises à 3 décimales", () => {
    // 10,000 BHD × 2,65 = 26,50 USD
    expect(convertMinor(10000n, "2.65", 3, 2)).toBe(2650n);
  });

  it("applique la marge comme la base (round à 15 décimales)", () => {
    expect(applyMarginToRate("655.957", 150)).toBe("646.117645");
    expect(applyMarginToRate("1", 0)).toBe("1");
    expect(applyMarginToRate("0.000000000000001", 5000 / 10)).toBe("0.000000000000001");
    expect(() => applyMarginToRate("1", 1501)).toThrow(MoneyError);
  });

  it("calcule un taux croisé via la devise pivot", () => {
    // USD→EUR 0.92, USD→XOF 603.48 → EUR→XOF = 655.956521739130435
    expect(crossRate("0.92", "603.48")).toBe("655.956521739130435");
  });

  it("formate pour l'affichage sans passer par un flottant", () => {
    // Intl utilise des espaces insécables : on les normalise pour la comparaison.
    const plain = (value: string): string => value.replace(/\s/g, " ");
    expect(plain(formatMoney(Money.ofMinor(123456789012345n, EUR), 2, "fr-FR"))).toBe("1 234 567 890 123,45 €");
    expect(plain(formatMoney(Money.ofMinor(64611n, XOF), 0, "fr-FR"))).toBe("64 611 F CFA");
  });
});
