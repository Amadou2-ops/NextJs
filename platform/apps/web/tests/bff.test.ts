import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { decimalToMinor, formatMoney, minorToDecimal } from "../src/lib/format";
import { trustedPaymentUrl } from "../src/lib/payment";
import { ApiError, apiRequest, clientIpFrom } from "../src/server/api";
import type { ApiTransport } from "../src/server/api";
import { parseWebConfig } from "../src/server/env";
import { refreshSession } from "../src/server/refresh";
import { seal, unseal } from "../src/server/sealing";
import type { WebSession } from "../src/server/session";
import { accessTokenExpiring, safeNextPath, sealPending, sealSession, sessionSchema, unsealPending, unsealSession } from "../src/server/session";

const key = (): Buffer => randomBytes(32);

const session: WebSession = {
  userId: "6f0d2a4e-7c1b-4d8e-9a3f-2b5c8e1d7a90",
  sessionId: "0b7a7c5e-3d21-4c8f-9a51-1f2e3d4c5b6a",
  accessToken: "eyJhbGciOiJFZERTQSJ9.payload-de-test.signature",
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  refreshToken: "rt_jeton-de-renouvellement-de-test",
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

describe("scellement des cookies", () => {
  it("chiffre, authentifie et refuse toute altération, autre usage ou expiration", async () => {
    const keys = [key()];
    const token = await seal(keys, "session", { a: 1 }, new Date(Date.now() + 60_000));
    expect(token).not.toContain("\"a\"");
    const schema = sessionSchema.pick({}).loose();
    expect(await unseal(keys, "session", token, schema)).toEqual({ a: 1 });
    expect(await unseal(keys, "pending", token, schema)).toBeNull();
    expect(await unseal([key()], "session", token, schema)).toBeNull();
    const parts = token.split(".");
    const tampered = [...parts.slice(0, 3), `${parts[3]?.slice(0, -2) ?? ""}AA`, parts[4]].join(".");
    expect(await unseal(keys, "session", tampered, schema)).toBeNull();
    expect(await unseal(keys, "session", token, schema, new Date(Date.now() + 120_000))).toBeNull();
    expect(await unseal(keys, "session", "pas.un.jeton", schema)).toBeNull();
  });

  it("lit les cookies scellés par la clé précédente pendant une rotation", async () => {
    const previous = key();
    const active = key();
    const cookie = await sealSession([previous], session);
    expect(await unsealSession([active, previous], cookie.value)).toEqual(session);
    expect(await unsealSession([active], cookie.value)).toBeNull();
  });

  it("pose des cookies __Host- HttpOnly, Secure, SameSite=Strict", async () => {
    const cookie = await sealSession([key()], session);
    expect(cookie.name).toBe("__Host-tp_session");
    expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    expect(cookie.options.expires.toISOString()).toBe(session.refreshTokenExpiresAt);
    const keys = [key()];
    const pending = await sealPending(keys, { kind: "login", loginChallengeId: session.sessionId, method: "totp", next: safeNextPath("/envoyer") });
    expect(await unsealPending(keys, pending.value)).toMatchObject({ kind: "login", next: "/envoyer" });
  });
});

describe("session et redirections", () => {
  it("détecte un jeton d'accès sur le point d'expirer", () => {
    const now = new Date();
    expect(accessTokenExpiring({ ...session, accessTokenExpiresAt: new Date(now.getTime() + 30_000).toISOString() }, now)).toBe(true);
    expect(accessTokenExpiring({ ...session, accessTokenExpiresAt: new Date(now.getTime() + 300_000).toISOString() }, now)).toBe(false);
  });

  it("n'accepte que des chemins internes après connexion", () => {
    expect(safeNextPath("/transferts/abc?onglet=1")).toBe("/transferts/abc?onglet=1");
    for (const hostile of ["//evil.example", "https://evil.example", "/\\evil.example", "/api/estimation", "javascript:alert(1)", "envoyer", `/${"a".repeat(250)}`]) {
      expect(safeNextPath(hostile), hostile).toBeNull();
    }
  });

  it("n'accepte que les pages de paiement hébergées connues, en https", () => {
    expect(trustedPaymentUrl("https://checkout.flutterwave.com/v3/hosted/pay/abc")).toBe("https://checkout.flutterwave.com/v3/hosted/pay/abc");
    expect(trustedPaymentUrl("http://checkout.flutterwave.com/pay")).toBeNull();
    expect(trustedPaymentUrl("https://checkout.flutterwave.com.evil.example/pay")).toBeNull();
    expect(trustedPaymentUrl("https://user:pass@checkout.flutterwave.com/pay")).toBeNull();
    expect(trustedPaymentUrl("pas une url")).toBeNull();
  });
});

describe("client de l'API", () => {
  function transport(fetchImpl: typeof fetch): ApiTransport {
    return { baseUrl: "https://api.internal", timeoutMs: 1000, fetch: fetchImpl };
  }

  it("transmet jeton, adresse du navigateur, agent et clé d'idempotence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 })));
    await apiRequest(transport(fetchImpl), { method: "POST", path: "/v1/transfers", body: { a: 1 }, accessToken: "jeton", idempotencyKey: true, context: { ipAddress: "203.0.113.9", userAgent: "Navigateur" } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(url instanceof URL ? url.href : url).toBe("https://api.internal/v1/transfers");
    expect(headers.get("authorization")).toBe("Bearer jeton");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.get("user-agent")).toBe("Navigateur");
    expect(headers.get("idempotency-key")).toMatch(/^web-[0-9a-f-]{36}$/);
    expect(init?.redirect).toBe("error");
  });

  it("convertit les problèmes RFC 9457 et les pannes réseau en ApiError", async () => {
    const problem = { code: "KYC_LIMIT_EXCEEDED", title: "Plafond", detail: "Plafond atteint", issues: [{ path: "body.amount", message: "trop élevé" }] };
    await expect(apiRequest(transport(() => Promise.resolve(new Response(JSON.stringify(problem), { status: 403 }))), { path: "/v1/kyc", context: { ipAddress: null, userAgent: null } })).rejects.toMatchObject({
      status: 403,
      code: "KYC_LIMIT_EXCEEDED",
      issues: [{ path: "body.amount", message: "trop élevé" }],
    });
    const failure = await apiRequest(transport(() => Promise.reject(new TypeError("fetch failed"))), { path: "/v1/kyc", context: { ipAddress: null, userAgent: null } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
  });

  it("lit l'adresse du navigateur derrière le nombre de relais de confiance", () => {
    expect(clientIpFrom("198.51.100.7, 203.0.113.9", 1)).toBe("203.0.113.9");
    expect(clientIpFrom("1.1.1.1, 198.51.100.7, 10.0.0.2", 2)).toBe("198.51.100.7");
    expect(clientIpFrom("198.51.100.7", 2)).toBeNull();
    expect(clientIpFrom("<script>", 1)).toBeNull();
    expect(clientIpFrom(null, 1)).toBeNull();
  });

  it("ne renouvelle qu'une fois pour des requêtes simultanées (jeton à usage unique)", async () => {
    const renewed = { ...session, accessToken: "nouveau.jeton.acces", refreshToken: "rt_nouveau-jeton-de-renouvellement" };
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ status: "authenticated", ...renewed }), { status: 200 })), 20)));
    const context = { ipAddress: null, userAgent: null };
    const unique = { ...session, refreshToken: `rt_${randomBytes(8).toString("hex")}` };
    const results = await Promise.all([refreshSession(transport(fetchImpl), unique, context), refreshSession(transport(fetchImpl), unique, context), refreshSession(transport(fetchImpl), unique, context)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toEqual({ kind: "refreshed", session: renewed });
    const expired = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 })));
    expect(await refreshSession(transport(expired), { ...session, refreshToken: `rt_${randomBytes(8).toString("hex")}` }, context)).toEqual({ kind: "expired" });
  });
});

describe("configuration", () => {
  const valid = { API_BASE_URL: "http://api.internal:8080/", APP_ORIGIN: "https://app.transfertplus.com", SESSION_ENCRYPTION_KEY: key().toString("base64"), NODE_ENV: "production" };

  it("accepte une configuration conforme", () => {
    expect(parseWebConfig(valid)).toMatchObject({ production: true, apiBaseUrl: "http://api.internal:8080", appOrigin: "https://app.transfertplus.com", trustedProxyHops: 1 });
  });

  it("refuse une origine en clair en production, une clé invalide ou identique à la précédente", () => {
    expect(() => parseWebConfig({ ...valid, APP_ORIGIN: "http://app.transfertplus.com" })).toThrow(/https/);
    expect(() => parseWebConfig({ ...valid, APP_ORIGIN: "https://app.transfertplus.com/chemin" })).toThrow(/origine/);
    expect(() => parseWebConfig({ ...valid, SESSION_ENCRYPTION_KEY: "courte" })).toThrow(/32 octets/);
    expect(() => parseWebConfig({ ...valid, SESSION_ENCRYPTION_KEY_PREVIOUS: valid.SESSION_ENCRYPTION_KEY })).toThrow(/différer/);
  });
});

describe("montants affichés", () => {
  it("convertit unités mineures ↔ décimal sans virgule flottante", () => {
    expect(minorToDecimal("10199", 2)).toBe("101.99");
    expect(minorToDecimal("5", 2)).toBe("0.05");
    expect(minorToDecimal("64611", 0)).toBe("64611");
    expect(minorToDecimal("123456789012345678", 2)).toBe("1234567890123456.78");
    expect(decimalToMinor("101,99", 2)).toBe("10199");
    expect(decimalToMinor("1 000", 0)).toBe("1000");
    expect(decimalToMinor("10.999", 2)).toBeNull();
    expect(decimalToMinor("0", 2)).toBeNull();
    expect(decimalToMinor("-5", 2)).toBeNull();
  });

  it("formate selon les décimales ISO 4217 de la devise", () => {
    expect(formatMoney({ amount: "10199", currency: "EUR" }).replace(/\s/g, " ")).toBe("101,99 €");
    expect(formatMoney({ amount: "64611", currency: "XOF" }).replace(/\s/g, " ")).toMatch(/^64 611 F\s?CFA$/);
  });
});
