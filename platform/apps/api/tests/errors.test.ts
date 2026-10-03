import { describe, expect, it } from "vitest";

import { AppError, FinancialError, InternalError, ServiceUnavailableError, toAppError, toProblem } from "../src/lib/errors.js";

function pgError(code: string, message = "erreur base"): Error {
  return Object.assign(new Error(message), { code });
}

describe("traduction des erreurs PostgreSQL", () => {
  it.each([
    ["LG001", "INSUFFICIENT_FUNDS", 422],
    ["LG003", "ACCOUNT_NOT_POSTABLE", 423],
    ["LG005", "IDEMPOTENCY_CONFLICT", 422],
    ["LG006", "IMMUTABLE_RECORD", 409],
    ["TR001", "INVALID_STATUS_TRANSITION", 409],
    ["TR002", "QUOTE_EXPIRED_OR_CONSUMED", 409],
    ["BO001", "FOUR_EYES_VIOLATION", 403],
  ] as const)("%s → %s (%i)", (sqlState, code, status) => {
    const error = toAppError(pgError(sqlState));
    expect(error).toBeInstanceOf(FinancialError);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
  });

  it("ne divulgue jamais le message de la base au client", () => {
    const error = toAppError(pgError("LG001", "ledger : provision insuffisante sur customer:abc (disponible 10)"));
    const problem = toProblem(error, "req-1", "/v1/transfers");
    expect(JSON.stringify(problem)).not.toContain("customer:abc");
    expect(error.internalContext).toMatchObject({ sqlState: "LG001" });
  });

  it("traduit les erreurs transitoires en 503", () => {
    for (const code of ["40001", "40P01", "57014", "55P03", "08006"]) {
      expect(toAppError(pgError(code))).toBeInstanceOf(ServiceUnavailableError);
    }
  });

  it("traduit un privilège refusé en erreur interne (défaut de configuration)", () => {
    expect(toAppError(pgError("42501"))).toBeInstanceOf(InternalError);
  });

  it("traduit l'unicité en conflit et les contraintes en données refusées", () => {
    expect(toAppError(pgError("23505")).code).toBe("CONFLICT");
    expect(toAppError(pgError("23514")).code).toBe("VALIDATION_FAILED");
  });

  it("encapsule toute erreur inconnue en INTERNAL_ERROR", () => {
    const error = toAppError(new TypeError("undefined is not a function"));
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.detail).not.toContain("undefined");
  });

  it("produit un document RFC 9457", () => {
    const problem = toProblem(new AppError("NOT_FOUND", 404, "Introuvable", { detail: "x" }), "req-9", "/v1/x");
    expect(problem).toEqual({
      type: "https://docs.transfertplus.example/errors/not-found",
      title: "Introuvable",
      status: 404,
      detail: "x",
      instance: "/v1/x",
      code: "NOT_FOUND",
      requestId: "req-9",
    });
  });
});
