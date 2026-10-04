import { randomBytes } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env["API_BASE_URL"] = "http://127.0.0.1:9";
  process.env["APP_ORIGIN"] = "https://admin.transfertplus.test";
  process.env["SESSION_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
});

const ORIGIN = "https://admin.transfertplus.test";

/** Proxy du back-office : contrôle d'origine, CSP stricte, tout l'espace exige une session. */
describe("proxy du back-office", () => {
  it("refuse toute mutation sans l'origine exacte du back-office", async () => {
    const { proxy } = await import("../src/proxy");
    for (const origin of [null, "https://evil.example", "https://app.transfertplus.test", `${ORIGIN}.evil.example`]) {
      const headers = new Headers({ "content-type": "text/plain" });
      if (origin !== null) headers.set("origin", origin);
      const response = await proxy(new NextRequest(`${ORIGIN}/approbations/x`, { method: "POST", headers }));
      expect(response.status, String(origin)).toBe(403);
    }
    const allowed = await proxy(new NextRequest(`${ORIGIN}/connexion`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(allowed.status).toBe(200);
  });

  it("pose une CSP sans aucun tiers ni style en ligne, nonce unique par requête", async () => {
    const { proxy, contentSecurityPolicy } = await import("../src/proxy");
    const first = await proxy(new NextRequest(`${ORIGIN}/connexion`));
    const second = await proxy(new NextRequest(`${ORIGIN}/connexion`));
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic';/);
    expect(csp).toMatch(/style-src 'self' 'nonce-/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:\/\//);
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    // En développement seulement : évaluation et styles en ligne (rechargement à chaud).
    expect(contentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
  });

  it("exige une session partout hors connexion et enrôlement, et efface un cookie forgé", async () => {
    const { proxy } = await import("../src/proxy");
    const anonymous = await proxy(new NextRequest(`${ORIGIN}/registre/comptes/123?avant=5`));
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`${ORIGIN}/connexion?suite=%2Fregistre%2Fcomptes%2F123%3Favant%3D5`);
    const home = await proxy(new NextRequest(`${ORIGIN}/`));
    expect(home.headers.get("location")).toBe(`${ORIGIN}/connexion`);
    for (const path of ["/connexion", "/enrolement", "/acces-refuse"]) {
      const response = await proxy(new NextRequest(`${ORIGIN}${path}`));
      expect(response.status, path).toBe(path === "/acces-refuse" ? 303 : 200);
    }
    const forged = await proxy(new NextRequest(`${ORIGIN}/connexion`, { headers: { cookie: "__Host-tpa_session=forge.forge.forge.forge.forge" } }));
    expect(forged.headers.get("set-cookie")).toMatch(/__Host-tpa_session=;.*Expires=Thu, 01 Jan 1970/i);
  });
});
