import { describe, expect, it } from "vitest";

import { amountToMinor, formatBps, minorToInput, parisLocalToIso, percentToBps } from "../src/lib/configuration";

/** Conversions de saisie du paramétrage : jamais de flottant, heure de Paris exacte. */

describe("saisie du paramétrage", () => {
  it("convertit une heure de Paris en instant exact, changement d'heure compris", () => {
    expect(parisLocalToIso("2026-07-01T10:00")).toBe("2026-07-01T08:00:00.000Z");
    expect(parisLocalToIso("2026-01-15T10:00")).toBe("2026-01-15T09:00:00.000Z");
    // Heure sautée au printemps : refusée plutôt que décalée en silence.
    expect(parisLocalToIso("2026-03-29T02:30")).toBeNull();
    expect(parisLocalToIso("2026-10-25T03:30")).toBe("2026-10-25T02:30:00.000Z");
    expect(parisLocalToIso("2026-13-01T10:00")).toBeNull();
    expect(parisLocalToIso("demain")).toBeNull();
  });

  it("lit des pourcentages en points de base entiers", () => {
    expect(percentToBps("1,5")).toBe(150);
    expect(percentToBps("0.75")).toBe(75);
    expect(percentToBps("12")).toBe(1200);
    expect(percentToBps("1,234")).toBeNull();
    expect(percentToBps("-1")).toBeNull();
    expect(formatBps(150)).toMatch(/^1,50\s%$/);
  });

  it("lit des montants en unités mineures selon la devise", () => {
    expect(amountToMinor("3", "EUR", false)).toBe("300");
    expect(amountToMinor("2,99", "EUR", false)).toBe("299");
    expect(amountToMinor("0", "EUR", false)).toBeNull();
    expect(amountToMinor("0", "EUR", true)).toBe("0");
    expect(amountToMinor("5000", "XOF", false)).toBe("5000");
    expect(amountToMinor("1,5", "XOF", false)).toBeNull();
    expect(minorToInput("2500", "EUR")).toBe("25,00");
  });
});
