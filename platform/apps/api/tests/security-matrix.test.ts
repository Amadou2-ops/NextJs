import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOwnerPool, seedAdmin, seedCustomer, signAccessToken } from "./support/fixtures.js";
import type { SeededAdmin, SeededCustomer } from "./support/fixtures.js";
import { createFullApplication, routesOf } from "./support/fullApplication.js";
import type { FullApplication } from "./support/fullApplication.js";

/**
 * Matrice d'autorisation exhaustive : chaque route exposée par l'API
 * (énumérée depuis les routeurs montés, comme dans src/server.ts) est appelée
 * sans jeton, avec un jeton client, avec un jeton du personnel et avec un
 * rôle insuffisant. Une route ajoutée sans protection fait échouer ce test.
 */

const PUBLIC_ROUTES = new Set([
  "post /v1/auth/device-challenges",
  "post /v1/auth/registration/start",
  "post /v1/auth/registration/complete",
  "post /v1/auth/login",
  "post /v1/auth/login/verify",
  "post /v1/auth/token/refresh",
  "post /v1/auth/passkeys/authentication/options",
  "post /v1/auth/passkeys/authentication/verify",
  "get /v1/fx/estimate",
  "post /v1/admin/auth/enrollment/options",
  "post /v1/admin/auth/enrollment/complete",
  "post /v1/admin/auth/login",
  "post /v1/admin/auth/login/verify",
  "post /v1/admin/auth/token/refresh",
]);

/** Routes d'administration ouvertes au rôle support (customers:read, transfers:read, kyc:read). */
const SUPPORT_ROUTES = new Set([
  "get /v1/admin/me",
  "post /v1/admin/auth/logout",
  "get /v1/admin/customers",
  "get /v1/admin/customers/:id",
  "get /v1/admin/transfers",
  "get /v1/admin/transfers/:id",
  "get /v1/admin/kyc/reviews",
  "get /v1/admin/kyc/verifications/:id",
]);

const PARAMETER_VALUES: Readonly<Record<string, string>> = { currency: "EUR", role: "risk_manager" };

function concrete(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => PARAMETER_VALUES[name] ?? randomUUID());
}

let full: FullApplication;
let routes: readonly { readonly method: string; readonly path: string }[];
const owner = createOwnerPool();
let customer: SeededCustomer;
let support: SeededAdmin;
let customerToken: string;
let supportToken: string;

beforeAll(async () => {
  full = await createFullApplication();
  routes = routesOf(full.routers);
  customer = await seedCustomer(owner, { webAssuranceLevel: 2 });
  support = await seedAdmin(owner, "support");
  await owner.query("UPDATE backoffice.admin_users SET allowed_ip_ranges = '{127.0.0.1/32,::1/128}' WHERE id = $1", [support.adminId]);
  customerToken = await signAccessToken({ key: full.keys.customer, audience: "web", subject: customer.userId, sessionId: customer.webSessionId, assuranceLevel: 2 });
  supportToken = await signAccessToken({ key: full.keys.admin, audience: "admin", subject: support.adminId, sessionId: support.sessionId, assuranceLevel: 2 });
});

afterAll(async () => {
  await full.close();
  await owner.end();
});

function call(method: string, path: string, token?: string): request.Test {
  const agent = request(full.app);
  const pending =
    method === "get" ? agent.get(path) : method === "post" ? agent.post(path) : method === "delete" ? agent.delete(path) : method === "patch" ? agent.patch(path) : agent.put(path);
  if (token !== undefined) pending.set("Authorization", `Bearer ${token}`);
  return pending.set("Idempotency-Key", `matrix-${randomUUID()}`).send({});
}

describe("matrice d'autorisation", () => {
  it("énumère toutes les routes montées", () => {
    expect(routes.length).toBeGreaterThanOrEqual(90);
    for (const route of PUBLIC_ROUTES) expect(routes.map((item) => `${item.method} ${item.path}`)).toContain(route);
  });

  it("exige un jeton sur toute route non publique", async () => {
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key) || route.path.startsWith("/v1/webhooks/")) continue;
      const response = await call(route.method, concrete(route.path));
      expect(response.status, key).toBe(401);
    }
  });

  it("refuse un jeton client sur le back-office et un jeton du personnel côté client", async () => {
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key) || route.path.startsWith("/v1/webhooks/")) continue;
      const isAdmin = route.path.startsWith("/v1/admin/");
      const response = await call(route.method, concrete(route.path), isAdmin ? customerToken : supportToken);
      expect(response.status, `${key} avec un jeton ${isAdmin ? "client" : "du personnel"}`).toBe(401);
    }
  });

  it("applique le RBAC sur chaque route du back-office", async () => {
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (!route.path.startsWith("/v1/admin/") || PUBLIC_ROUTES.has(key) || key === "post /v1/admin/auth/logout") continue;
      const response = await call(route.method, concrete(route.path), supportToken);
      if (SUPPORT_ROUTES.has(key)) expect([200, 400, 404], key).toContain(response.status);
      else expect(response.status, key).toBe(403);
    }
  });

  it("refuse les webhooks non signés sans rien enregistrer", async () => {
    const before = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM integrations.webhook_events");
    for (const route of routes.filter((item) => item.path.startsWith("/v1/webhooks/"))) {
      const response = await request(full.app).post(route.path).set("Content-Type", "application/json").send('{"event":"forged"}');
      expect([400, 401, 403], route.path).toContain(response.status);
    }
    const after = await owner.query<{ count: string }>("SELECT count(*)::text AS count FROM integrations.webhook_events");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("répond sans fuite d'information : en-têtes de sécurité, pas de cache, problème RFC 9457", async () => {
    const response = await call("get", "/v1/admin/customers", customerToken);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["strict-transport-security"]).toBeDefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(JSON.stringify(response.body)).not.toMatch(/stack|select |postgres|backoffice\./i);
  });
});
