import { randomBytes } from "node:crypto";

import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { adjustmentEntries } from "../src/lib/adjustment";
import { decimalToMinor, formatMoney, minorToDecimal } from "../src/lib/format";
import { ipRanges } from "../src/lib/forms";
import { userMessage } from "../src/lib/errors";
import { apiRequest, clientIpFrom } from "../src/server/api";
import type { ApiTransport } from "../src/server/api";
import { parseAdminConfig } from "../src/server/env";
import { refreshSession } from "../src/server/refresh";
import { seal } from "../src/server/sealing";
import type { AdminSession } from "../src/server/session";
import { safeNextPath, sealPending, sealSession, sessionFromTokens, sessionSchema, unsealPending, unsealSession } from "../src/server/session";

const key = (): Buffer => randomBytes(32);
const ADMIN_ID = "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90";
const SESSION_ID = "0b7a7c5e-3d21-4c8f-9a51-1f2e3d4c5b6a";

async function accessToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(ADMIN_ID).setAudience("admin").setExpirationTime("10m").sign(randomBytes(32));
}

async function session(): Promise<AdminSession> {
  return {
    adminId: ADMIN_ID,
    sessionId: SESSION_ID,
    accessToken: await accessToken({ sid: SESSION_ID }),
    accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    refreshToken: `art_${randomBytes(32).toString("base64url")}`,
    sessionExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  };
}

function transport(fetchImpl: typeof fetch): ApiTransport {
  return { baseUrl: "https://api.internal", timeoutMs: 1000, fetch: fetchImpl };
}

describe("session du personnel", () => {
  it("lit le membre et la session dans le jeton d'accès reçu de l'API", async () => {
    const token = await accessToken({ sid: SESSION_ID });
    const tokens = { accessToken: token, accessTokenExpiresAt: new Date().toISOString(), refreshToken: `art_${"a".repeat(43)}`, sessionExpiresAt: new Date().toISOString() };
    expect(sessionFromTokens(tokens)).toMatchObject({ adminId: ADMIN_ID, sessionId: SESSION_ID });
    // Jeton sans session ou jeton de renouvellement d'un autre format : refusés.
    await expect(async () => sessionFromTokens({ ...tokens, accessToken: await accessToken({}) })).rejects.toThrow();
    expect(() => sessionFromTokens({ ...tokens, refreshToken: "rt_client" })).toThrow();
  });

  it("scelle un cookie __Host- strict qui expire avec la session absolue et n'est pas interchangeable avec celui du site client", async () => {
    const keys = [key()];
    const current = await session();
    const cookie = await sealSession(keys, current);
    expect(cookie.name).toBe("__Host-tpa_session");
    expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    expect(cookie.options.expires.toISOString()).toBe(current.sessionExpiresAt);
    expect(await unsealSession(keys, cookie.value)).toEqual(current);
    // Même clé, autre usage (cookie du site client « session ») : refusé.
    const foreign = await seal(keys, "session", current, new Date(Date.now() + 60_000));
    expect(await unsealSession(keys, foreign)).toBeNull();
    expect(sessionSchema.safeParse({ ...current, refreshToken: "rt_x" }).success).toBe(false);
  });

  it("conserve le défi WebAuthn en cours 5 minutes, par type d'étape", async () => {
    const keys = [key()];
    const pending = await sealPending(keys, { kind: "login", challengeId: SESSION_ID, next: safeNextPath("/approbations") });
    expect(pending.options.expires.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(await unsealPending(keys, pending.value)).toEqual({ kind: "login", challengeId: SESSION_ID, next: "/approbations" });
  });

  it("ne redirige après connexion que vers une page interne du back-office", () => {
    expect(safeNextPath("/transferts/abc?status=funded")).toBe("/transferts/abc?status=funded");
    for (const hostile of ["//evil.example", "https://evil.example", "/\\evil", "/connexion?suite=/x", "/enrolement", "/api/x", "javascript:alert(1)"]) {
      expect(safeNextPath(hostile), hostile).toBeNull();
    }
  });
});

describe("client de l'API du back-office", () => {
  it("transmet le jeton et l'adresse du navigateur (contrôle des plages autorisées)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await apiRequest(transport(fetchImpl), { path: "/v1/admin/me", accessToken: "jeton", context: { ipAddress: "203.0.113.9", userAgent: "Navigateur" } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(url instanceof URL ? url.href : url).toBe("https://api.internal/v1/admin/me");
    expect(headers.get("authorization")).toBe("Bearer jeton");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.has("idempotency-key")).toBe(false);
    expect(init?.redirect).toBe("error");
    expect(clientIpFrom("198.51.100.7, 203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("renouvelle une seule fois pour des requêtes simultanées et traite 401/403 comme une fin de session", async () => {
    const current = await session();
    const renewed = { accessToken: await accessToken({ sid: SESSION_ID }), accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(), refreshToken: `art_${randomBytes(32).toString("base64url")}`, sessionExpiresAt: current.sessionExpiresAt };
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(renewed), { status: 200 })), 20)));
    const context = { ipAddress: null, userAgent: null };
    const results = await Promise.all([refreshSession(transport(fetchImpl), current, context), refreshSession(transport(fetchImpl), current, context)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.pathname : url).toBe("/v1/admin/auth/token/refresh");
    for (const result of results) expect(result).toMatchObject({ kind: "refreshed", session: { adminId: ADMIN_ID, refreshToken: renewed.refreshToken } });

    for (const status of [401, 403]) {
      const denied = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ code: "FORBIDDEN" }), { status })));
      expect(await refreshSession(transport(denied), await session(), context)).toEqual({ kind: "expired" });
    }
  });

  it("présente le détail de l'API au personnel, jamais celui d'un refus d'identifiants", () => {
    expect(userMessage("FORBIDDEN", "Le demandeur ne peut pas approuver sa propre demande.")).toBe("Le demandeur ne peut pas approuver sa propre demande.");
    expect(userMessage("INVALID_CREDENTIALS", "Mot de passe incorrect")).toBe("Identifiants ou clé de sécurité refusés.");
    expect(userMessage("XYZ")).toBe("Erreur inattendue (XYZ).");
  });
});

describe("configuration", () => {
  const valid = { API_BASE_URL: "http://api.internal:8080", APP_ORIGIN: "https://admin.transfertplus.com", SESSION_ENCRYPTION_KEY: key().toString("base64"), NODE_ENV: "production" };

  it("exige https en production et une clé de 32 octets", () => {
    expect(parseAdminConfig(valid)).toMatchObject({ production: true, appOrigin: "https://admin.transfertplus.com", trustedProxyHops: 1 });
    expect(() => parseAdminConfig({ ...valid, APP_ORIGIN: "http://admin.transfertplus.com" })).toThrow(/https/);
    expect(() => parseAdminConfig({ ...valid, SESSION_ENCRYPTION_KEY: "courte" })).toThrow(/32 octets/);
  });
});

describe("montants et ajustements", () => {
  it("affiche les montants signés exactement (comptes techniques négatifs)", () => {
    expect(minorToDecimal("-10199", 2)).toBe("-101.99");
    expect(minorToDecimal("-5", 2)).toBe("-0.05");
    expect(minorToDecimal("123456789012345678", 2)).toBe("1234567890123456.78");
    expect(formatMoney("-10199", "EUR").replace(/\s/g, " ")).toBe("-101,99 €");
    expect(() => minorToDecimal("1.5", 2)).toThrow();
    expect(decimalToMinor("1 000,50", 2)).toBe("100050");
  });

  it("convertit les lignes d'ajustement selon la devise et exige l'équilibre par devise", () => {
    const account = (n: number): string => `00000000-0000-4000-8000-00000000000${n.toString()}`;
    const balanced = adjustmentEntries({ accountId: [account(1), account(2)], direction: ["debit", "credit"], amount: ["10,50", "10.5"], currency: ["EUR", "EUR"] });
    expect(balanced).toEqual({
      entries: [
        { accountId: account(1), direction: "debit", amountMinor: "1050", currency: "EUR" },
        { accountId: account(2), direction: "credit", amountMinor: "1050", currency: "EUR" },
      ],
    });
    expect(adjustmentEntries({ accountId: [account(1), account(2)], direction: ["debit", "credit"], amount: ["1000", "999"], currency: ["XOF", "XOF"] })).toMatchObject({ error: expect.stringMatching(/équilibré en XOF/) as unknown });
    expect(adjustmentEntries({ accountId: [account(1), account(2)], direction: ["debit", "credit"], amount: ["10.5", "10.5"], currency: ["XOF", "XOF"] })).toMatchObject({ error: expect.stringMatching(/Ligne 1/) as unknown });
    expect(adjustmentEntries({ accountId: [account(1)], direction: ["debit"], amount: ["1"], currency: ["EUR"] })).toMatchObject({ error: expect.stringMatching(/entre 2 et 20/) as unknown });
    // Équilibre devise par devise : un excédent EUR ne compense pas un déficit USD.
    expect(
      adjustmentEntries({ accountId: [account(1), account(2), account(3), account(4)], direction: ["debit", "credit", "debit", "credit"], amount: ["2", "1", "1", "2"], currency: ["EUR", "EUR", "USD", "USD"] }),
    ).toMatchObject({ error: expect.stringMatching(/équilibré en EUR/) as unknown });
  });

  it("n'accepte que des plages d'adresses CIDR", () => {
    expect(ipRanges.parse("203.0.113.0/24, 2001:db8::/48")).toEqual(["203.0.113.0/24", "2001:db8::/48"]);
    expect(ipRanges.safeParse("203.0.113.5").success).toBe(false);
    expect(ipRanges.safeParse("").success).toBe(false);
  });
});
