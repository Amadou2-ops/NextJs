import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMemoryRateLimiter } from "../src/middlewares/rateLimit.js";
import { validate, validatedBody } from "../src/middlewares/validate.js";
import { ADMIN_ORIGIN, WEB_ORIGIN, buildTestApp, buildTestConfig, createTestKeys } from "./support/fixtures.js";

const keys = await createTestKeys();
const config = buildTestConfig(keys);

const echoSchema = z.object({ amount: z.string().regex(/^[0-9]+$/), currency: z.string().length(3) }).strict();

const app = buildTestApp(config, {
  mountRoutes: (application) => {
    const router = Router();
    router.post("/v1/test/echo", validate({ body: echoSchema }), (req, res) => {
      res.status(201).json(validatedBody(req, echoSchema));
    });
    router.get("/v1/test/boom", () => {
      throw new Error("secret interne : mot de passe base = hunter2");
    });
    application.use(router);
  },
});

describe("en-têtes de sécurité", () => {
  it("applique CSP stricte, HSTS, anti-cadrage et absence de cache", async () => {
    const response = await request(app).get("/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("renvoie la version et l'identifiant de corrélation", async () => {
    const response = await request(app).get("/v1/health").set("X-Request-Id", "bff-req-12345678");
    expect(response.body).toEqual({ status: "ok", version: "1.2.3-test" });
    expect(response.headers["x-request-id"]).toBe("bff-req-12345678");
  });

  it("remplace un identifiant de corrélation mal formé", async () => {
    const response = await request(app).get("/v1/health").set("X-Request-Id", "<script>alert(1)</script>");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("CORS strict", () => {
  it("autorise les origines exactes configurées", async () => {
    for (const origin of [WEB_ORIGIN, ADMIN_ORIGIN]) {
      const response = await request(app)
        .options("/v1/test/echo")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key");
      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
    }
  });

  it("n'accorde rien à une origine inconnue ou voisine", async () => {
    for (const origin of ["https://evil.example", "https://app.transfertplus.test.evil.example", "http://app.transfertplus.test"]) {
      const response = await request(app).get("/v1/health").set("Origin", origin);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("rejette une requête mutatrice d'une origine non autorisée (CSRF)", async () => {
    const response = await request(app)
      .post("/v1/test/echo")
      .set("Origin", "https://evil.example")
      .send({ amount: "100", currency: "EUR" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("laisse passer les clients sans en-tête Origin (application mobile)", async () => {
    const response = await request(app).post("/v1/test/echo").send({ amount: "100", currency: "EUR" });
    expect(response.status).toBe(201);
  });
});

describe("corps de requête et validation", () => {
  it("renvoie les données validées", async () => {
    const response = await request(app).post("/v1/test/echo").send({ amount: "100", currency: "EUR" });
    expect(response.body).toEqual({ amount: "100", currency: "EUR" });
  });

  it("refuse les propriétés inconnues et les types invalides avec le détail des champs", async () => {
    const response = await request(app).post("/v1/test/echo").send({ amount: 100, currency: "EUR", admin: true });
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body.code).toBe("VALIDATION_FAILED");
    const paths = (response.body.issues as { path: string }[]).map((issue) => issue.path);
    expect(paths).toContain("body.amount");
    expect(paths.some((path) => path.startsWith("body"))).toBe(true);
  });

  it("refuse un JSON mal formé", async () => {
    const response = await request(app).post("/v1/test/echo").set("Content-Type", "application/json").send('{"amount": "1"');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  it("refuse un corps qui n'est pas du JSON", async () => {
    const response = await request(app).post("/v1/test/echo").set("Content-Type", "application/x-www-form-urlencoded").send("amount=1");
    expect(response.status).toBe(415);
    expect(response.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("refuse un corps trop volumineux", async () => {
    const response = await request(app)
      .post("/v1/test/echo")
      .send({ amount: "1", currency: "EUR", padding: "x".repeat(70 * 1024) });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("erreurs", () => {
  it("renvoie un 404 au format problem+json", async () => {
    const response = await request(app).get("/v1/inexistant?token=secret");
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "NOT_FOUND", status: 404, instance: "/v1/inexistant" });
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("masque les détails d'une erreur interne", async () => {
    const response = await request(app).get("/v1/test/boom");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
  });
});

describe("routes système", () => {
  it("publie uniquement les clés publiques clients", async () => {
    const response = await request(app).get("/.well-known/jwks.json");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ keys: [keys.customer.publicJwk] });
    expect(JSON.stringify(response.body)).not.toContain(keys.admin.kid);
    expect(response.headers["cache-control"]).toBe("public, max-age=300, must-revalidate");
  });

  it("signale une dépendance indisponible sans la nommer", async () => {
    const degraded = buildTestApp(config, {
      healthChecks: [{ name: "postgres", check: () => Promise.reject(new Error("connexion refusée")) }],
    });
    const response = await request(degraded).get("/v1/health");
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("postgres");
  });
});

describe("limitation de débit", () => {
  it("renvoie 429 avec Retry-After au-delà du quota", async () => {
    const limited = buildTestApp(config, {
      globalRateLimiter: createMemoryRateLimiter({ keyPrefix: "test-429", points: 2, durationSeconds: 60, blockDurationSeconds: 30 }),
    });
    expect((await request(limited).get("/v1/health")).headers["ratelimit-remaining"]).toBe("1");
    expect((await request(limited).get("/v1/health")).status).toBe(200);
    const blocked = await request(limited).get("/v1/health");
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
});
