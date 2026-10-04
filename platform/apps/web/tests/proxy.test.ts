import { randomBytes } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env["API_BASE_URL"] = "http://127.0.0.1:9";
  process.env["APP_ORIGIN"] = "https://app.transfertplus.test";
  process.env["SESSION_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
});

/** Proxy : contrôle d'origine des mutations, CSP à nonce, accès à l'espace client. */
describe("proxy", () => {
  it("refuse toute mutation sans origine du site, y compris sans en-tête Origin", async () => {
    const { proxy } = await import("../src/proxy");
    for (const origin of [null, "https://evil.example", "https://app.transfertplus.test.evil.example"]) {
      const headers = new Headers({ "content-type": "text/plain" });
      if (origin !== null) headers.set("origin", origin);
      const response = await proxy(new NextRequest("https://app.transfertplus.test/envoyer", { method: "POST", headers }));
      expect(response.status, String(origin)).toBe(403);
    }
    const allowed = await proxy(new NextRequest("https://app.transfertplus.test/connexion", { method: "POST", headers: { origin: "https://app.transfertplus.test" } }));
    expect(allowed.status).toBe(200);
  });

  it("pose une CSP stricte avec un nonce unique par requête", async () => {
    const { proxy } = await import("../src/proxy");
    const first = await proxy(new NextRequest("https://app.transfertplus.test/"));
    const second = await proxy(new NextRequest("https://app.transfertplus.test/"));
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
  });

  it("redirige l'espace client vers la connexion sans session, et efface un cookie illisible", async () => {
    const { proxy } = await import("../src/proxy");
    const anonymous = await proxy(new NextRequest("https://app.transfertplus.test/transferts/123?onglet=2"));
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("https://app.transfertplus.test/connexion?suite=%2Ftransferts%2F123%3Fonglet%3D2");
    const forged = await proxy(new NextRequest("https://app.transfertplus.test/", { headers: { cookie: "__Host-tp_session=forge.forge.forge.forge.forge" } }));
    expect(forged.headers.get("set-cookie")).toMatch(/__Host-tp_session=;.*Expires=Thu, 01 Jan 1970/i);
  });
});
