import { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresPermissionChecker } from "../src/auth/permissions.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { authenticate, requireAssuranceLevel2 } from "../src/middlewares/authenticate.js";
import { requirePermission } from "../src/middlewares/requirePermission.js";
import {
  buildTestApp,
  buildTestConfig,
  createApiPool,
  createOwnerPool,
  createSigningKey,
  createTestKeys,
  seedAdmin,
  seedCustomer,
  signAccessToken,
} from "./support/fixtures.js";
import type { SeededAdmin, SeededCustomer } from "./support/fixtures.js";

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
const deps = { verifier, sessions: new PostgresSessionValidator(apiPool) };
const permissions = new PostgresPermissionChecker(apiPool);

const app = buildTestApp(config, {
  mountRoutes: (application) => {
    const router = Router();
    router.get("/v1/me", authenticate(deps, ["mobile", "web"]), (req, res) => {
      res.json({ subjectId: req.auth?.subjectId, audience: req.auth?.audience, aal: req.auth?.assuranceLevel });
    });
    router.post("/v1/sensitive", authenticate(deps, ["mobile", "web"]), requireAssuranceLevel2(), (_req, res) => {
      res.status(201).json({ ok: true });
    });
    router.get("/v1/admin/kyc", authenticate(deps, ["admin"]), requirePermission(permissions, "kyc:read"), (_req, res) => {
      res.json({ ok: true });
    });
    router.post("/v1/admin/kyc/decide", authenticate(deps, ["admin"]), requirePermission(permissions, "kyc:decide"), (_req, res) => {
      res.json({ ok: true });
    });
    application.use(router);
  },
});

let customer: SeededCustomer;
let support: SeededAdmin;
let risk: SeededAdmin;

beforeAll(async () => {
  customer = await seedCustomer(owner);
  support = await seedAdmin(owner, "support");
  risk = await seedAdmin(owner, "risk_manager");
});

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

function mobileToken(overrides: Partial<Parameters<typeof signAccessToken>[0]> = {}): Promise<string> {
  return signAccessToken({
    key: keys.customer,
    audience: "mobile",
    subject: customer.userId,
    sessionId: customer.mobileSessionId,
    deviceId: customer.deviceId,
    assuranceLevel: 2,
    ...overrides,
  });
}

describe("authentification client", () => {
  it("accepte un jeton mobile valide lié à une session active", async () => {
    const response = await request(app).get("/v1/me").set("Authorization", `Bearer ${await mobileToken()}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ subjectId: customer.userId, audience: "mobile", aal: 2 });
  });

  it("accepte un jeton web (transmis par le BFF)", async () => {
    const token = await signAccessToken({ key: keys.customer, audience: "web", subject: customer.userId, sessionId: customer.webSessionId });
    const response = await request(app).get("/v1/me").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.audience).toBe("web");
  });

  it("exige un en-tête Authorization et ne lit jamais de cookie", async () => {
    const response = await request(app).get("/v1/me").set("Cookie", `access_token=${await mobileToken()}`);
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
  });

  it.each([
    ["signé par une clé inconnue", async () => mobileToken({ key: await createSigningKey("customer-key-2026-01") })],
    ["signé par la clé du personnel", () => mobileToken({ key: keys.admin })],
    ["d'un autre émetteur", () => mobileToken({ issuer: "https://evil.example" })],
    ["pour l'audience admin", () => mobileToken({ audience: "admin" })],
    ["expiré", () => mobileToken({ issuedAtOffsetSeconds: -1200, lifetimeSeconds: 600 })],
    ["d'une durée de vie excessive", () => mobileToken({ lifetimeSeconds: 3600 })],
    ["sans en-tête typ at+jwt", () => mobileToken({ typ: "JWT" })],
    ["mobile sans identifiant d'appareil", () => mobileToken({ deviceId: undefined as unknown as string })],
    ["d'un autre appareil", () => mobileToken({ deviceId: "00000000-0000-4000-8000-000000000000" })],
    ["pointant la session d'un autre client", async () => mobileToken({ sessionId: (await seedCustomer(owner)).mobileSessionId })],
  ])("refuse un jeton %s", async (_label, makeToken) => {
    const response = await request(app).get("/v1/me").set("Authorization", `Bearer ${await makeToken()}`);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  it("refuse l'algorithme none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ iss: config.jwt.issuer, aud: "mobile", sub: customer.userId, sid: customer.mobileSessionId, did: customer.deviceId, aal: 2, jti: "aaaaaaaaaaaaaaaaaaaaaa", iat: now, exp: now + 600 }),
    ).toString("base64url");
    const response = await request(app).get("/v1/me").set("Authorization", `Bearer ${header}.${payload}.${"A".repeat(43)}`);
    expect(response.status).toBe(401);
  });

  it("applique immédiatement la révocation de session", async () => {
    const victim = await seedCustomer(owner);
    const token = await signAccessToken({
      key: keys.customer, audience: "mobile", subject: victim.userId, sessionId: victim.mobileSessionId, deviceId: victim.deviceId,
    });
    expect((await request(app).get("/v1/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    await owner.query("UPDATE identity.sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1", [victim.mobileSessionId]);
    expect((await request(app).get("/v1/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("refuse un client suspendu et un appareil révoqué", async () => {
    const suspended = await seedCustomer(owner);
    const token = await signAccessToken({
      key: keys.customer, audience: "mobile", subject: suspended.userId, sessionId: suspended.mobileSessionId, deviceId: suspended.deviceId,
    });
    await owner.query("UPDATE identity.users SET status = 'suspended', suspended_at = now() WHERE id = $1", [suspended.userId]);
    expect((await request(app).get("/v1/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);

    const stolen = await seedCustomer(owner);
    const stolenToken = await signAccessToken({
      key: keys.customer, audience: "mobile", subject: stolen.userId, sessionId: stolen.mobileSessionId, deviceId: stolen.deviceId,
    });
    await owner.query("UPDATE identity.devices SET revoked_at = now(), revoked_reason = 'perte déclarée' WHERE id = $1", [stolen.deviceId]);
    expect((await request(app).get("/v1/me").set("Authorization", `Bearer ${stolenToken}`)).status).toBe(401);
  });

  it("retient le niveau d'assurance le plus faible entre jeton et session", async () => {
    const token = await signAccessToken({
      key: keys.customer, audience: "web", subject: customer.userId, sessionId: customer.webSessionId, assuranceLevel: 2,
    });
    const me = await request(app).get("/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.aal).toBe(1);
    const sensitive = await request(app).post("/v1/sensitive").set("Authorization", `Bearer ${token}`).send({});
    expect(sensitive.status).toBe(403);
    const mobile = await request(app).post("/v1/sensitive").set("Authorization", `Bearer ${await mobileToken()}`).send({});
    expect(mobile.status).toBe(201);
  });
});

describe("authentification et RBAC du personnel", () => {
  function adminToken(admin: SeededAdmin): Promise<string> {
    return signAccessToken({ key: keys.admin, audience: "admin", subject: admin.adminId, sessionId: admin.sessionId, assuranceLevel: 2 });
  }

  it("refuse un jeton client sur une route d'administration", async () => {
    const response = await request(app).get("/v1/admin/kyc").set("Authorization", `Bearer ${await mobileToken()}`);
    expect(response.status).toBe(401);
  });

  it("refuse un jeton admin signé par une clé client", async () => {
    const token = await signAccessToken({ key: keys.customer, audience: "admin", subject: risk.adminId, sessionId: risk.sessionId });
    expect((await request(app).get("/v1/admin/kyc").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("applique la matrice de permissions", async () => {
    const supportToken = await adminToken(support);
    const riskToken = await adminToken(risk);
    expect((await request(app).get("/v1/admin/kyc").set("Authorization", `Bearer ${supportToken}`)).status).toBe(200);
    const denied = await request(app).post("/v1/admin/kyc/decide").set("Authorization", `Bearer ${supportToken}`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    expect((await request(app).post("/v1/admin/kyc/decide").set("Authorization", `Bearer ${riskToken}`).send({})).status).toBe(200);
  });

  it("retire l'accès dès le retrait du rôle", async () => {
    const analyst = await seedAdmin(owner, "risk_manager");
    const token = await adminToken(analyst);
    expect((await request(app).post("/v1/admin/kyc/decide").set("Authorization", `Bearer ${token}`).send({})).status).toBe(200);
    await owner.query(
      `UPDATE backoffice.admin_user_roles SET revoked_at = now(), revoked_by_admin_id = $2
        WHERE admin_user_id = $1 AND revoked_at IS NULL`,
      [analyst.adminId, risk.adminId],
    );
    expect((await request(app).post("/v1/admin/kyc/decide").set("Authorization", `Bearer ${token}`).send({})).status).toBe(403);
  });
});
