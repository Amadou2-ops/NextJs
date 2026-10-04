import { randomBytes } from "node:crypto";

import { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { PostgresIdempotencyStore, canonicalJson } from "../src/lib/idempotency.js";
import { authenticate } from "../src/middlewares/authenticate.js";
import { requireIdempotency } from "../src/middlewares/idempotencyKey.js";
import { buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, seedCustomer, signAccessToken } from "./support/fixtures.js";
import type { SeededCustomer } from "./support/fixtures.js";

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
const auth = authenticate({ verifier, sessions: new PostgresSessionValidator(apiPool) }, ["mobile", "web"]);
const idempotency = requireIdempotency(new PostgresIdempotencyStore(apiPool));

let executions = 0;
let failNext = false;

const app = buildTestApp(config, {
  mountRoutes: (application) => {
    const router = Router();
    router.post("/v1/payments", auth, idempotency, (req, res) => {
      executions += 1;
      if (failNext) {
        failNext = false;
        throw new Error("panne du prestataire");
      }
      res.status(201).json({ paymentId: `pay_${executions}`, received: req.body as unknown });
    });
    router.post("/v1/slow", auth, idempotency, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.status(201).json({ done: true });
    });
    application.use(router);
  },
});

let customer: SeededCustomer;
let token: string;

beforeAll(async () => {
  customer = await seedCustomer(owner);
  token = await signAccessToken({
    key: keys.customer, audience: "mobile", subject: customer.userId, sessionId: customer.mobileSessionId, deviceId: customer.deviceId,
  });
});

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

function newKey(): string {
  return randomBytes(18).toString("base64url");
}

describe("idempotence HTTP", () => {
  it("exige l'en-tête Idempotency-Key", async () => {
    const response = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).send({ amount: "100" });
    expect(response.status).toBe(400);
    expect(response.body.issues[0].path).toBe("headers.idempotency-key");
  });

  it("rejoue la réponse d'origine sans réexécuter", async () => {
    const key = newKey();
    const before = executions;
    const first = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "100", currency: "EUR" });
    const second = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ currency: "EUR", amount: "100" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(executions - before).toBe(1);
  });

  it("refuse la réutilisation d'une clé pour une autre requête", async () => {
    const key = newKey();
    await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "100" });
    const reused = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "999" });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("isole les clés par client", async () => {
    const other = await seedCustomer(owner);
    const otherToken = await signAccessToken({
      key: keys.customer, audience: "mobile", subject: other.userId, sessionId: other.mobileSessionId, deviceId: other.deviceId,
    });
    const key = newKey();
    const a = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "1" });
    const b = await request(app).post("/v1/payments").set("Authorization", `Bearer ${otherToken}`).set("Idempotency-Key", key).send({ amount: "1" });
    expect(b.status).toBe(201);
    expect(b.headers["idempotency-replayed"]).toBeUndefined();
    expect(b.body.paymentId).not.toBe(a.body.paymentId);
  });

  it("signale une requête identique encore en cours", async () => {
    const key = newKey();
    const [first, second] = await Promise.all([
      request(app).post("/v1/slow").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({}),
      new Promise((resolve) => setTimeout(resolve, 80)).then(() =>
        request(app).post("/v1/slow").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({}),
      ),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("REQUEST_IN_PROGRESS");
    expect(second.headers["retry-after"]).toBe("1");
  });

  it("libère la clé après une erreur serveur pour permettre une nouvelle tentative", async () => {
    const key = newKey();
    failNext = true;
    const failed = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "5" });
    expect(failed.status).toBe(500);
    const retried = await request(app).post("/v1/payments").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ amount: "5" });
    expect(retried.status).toBe(201);
    expect(retried.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("produit une sérialisation canonique indépendante de l'ordre des clés", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ amount: 10n, skip: undefined })).toBe('{"amount":"10"}');
  });
});
