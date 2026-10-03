import { randomBytes, randomInt } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSessionValidator } from "../src/auth/sessions.js";
import { createMemoryRateLimiter } from "../src/middlewares/rateLimit.js";
import { AttestationError } from "../src/modules/auth/attestation/types.js";
import type { AttestationInput, AttestationResult, AttestationVerifier } from "../src/modules/auth/attestation/types.js";
import { createAuthModule } from "../src/modules/auth/index.js";
import type { SmsSender } from "../src/lib/sms/smsSender.js";
import { base32Decode, hotp, timeStep } from "../src/modules/auth/totp.js";
import { TestDevice } from "./support/device.js";
import { WEB_ORIGIN, buildTestApp, buildTestConfig, createApiPool, createOwnerPool, createTestKeys, silentLogger } from "./support/fixtures.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

/** SMS capturés (le test lit les codes comme le ferait l'utilisateur). */
class CapturingSms implements SmsSender {
  readonly messages: { readonly to: string; readonly body: string }[] = [];

  send(to: string, body: string): Promise<{ readonly providerMessageId: string }> {
    this.messages.push({ to, body });
    return Promise.resolve({ providerMessageId: `test-${this.messages.length}` });
  }

  lastCode(to: string): string {
    const message = [...this.messages].reverse().find((item) => item.to === to);
    const code = message === undefined ? undefined : /(\d{6})/.exec(message.body)?.[1];
    if (code === undefined) throw new Error(`aucun code envoyé à ${to}`);
    return code;
  }
}

/**
 * Vérificateur d'attestation de test : la vérification cryptographique réelle
 * est couverte par attestation.test.ts ; ici on contrôle le parcours
 * (défi à usage unique, refus, enregistrement de l'appareil).
 */
class AcceptingAttestation implements AttestationVerifier {
  readonly seen: AttestationInput[] = [];

  verify(input: AttestationInput): Promise<AttestationResult> {
    this.seen.push(input);
    if (input.evidence.type === "app_attest" && Buffer.from(input.evidence.attestationObject, "base64").toString() === "rejected") {
      return Promise.reject(new AttestationError("attestation refusée (test)"));
    }
    return Promise.resolve({ type: input.evidence.type, details: {} });
  }
}

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
const sms = new CapturingSms();
const attestation = new AcceptingAttestation();
const generous = { points: 10_000, durationSeconds: 60, blockDurationSeconds: 0 };
const authModule = createAuthModule({
  config,
  pool: apiPool,
  logger: silentLogger,
  sessions: new PostgresSessionValidator(apiPool),
  limiters: {
    publicByIp: createMemoryRateLimiter({ keyPrefix: "flows-ip", ...generous }),
    byPhone: createMemoryRateLimiter({ keyPrefix: "flows-phone", ...generous }),
  },
  overrides: { sms, attestation, breachChecker: null },
});
const app = buildTestApp(config, {
  mountRoutes: (application) => {
    application.use(authModule.router);
  },
});

const PASSWORD = "Teranga-Dakar-2026!";

function newSenegalPhone(): string {
  return `+22177${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
}

async function deviceRegistration(device: TestDevice, attestationObject = "valid") {
  const challenge = await request(app).post("/v1/auth/device-challenges").send({});
  expect(challenge.status).toBe(201);
  return {
    challengeId: challenge.body.challengeId as string,
    platform: "ios",
    name: "iPhone de Fatou",
    appVersion: "1.0.0",
    osVersion: "iOS 19.1",
    publicKey: device.publicKeySpki.toString("base64"),
    publicKeyAlgorithm: device.algorithm,
    attestation: {
      type: "app_attest",
      keyId: randomBytes(32).toString("base64"),
      attestationObject: Buffer.from(attestationObject).toString("base64"),
    },
  };
}

async function register(phone: string, client: Record<string, unknown> = { type: "web" }) {
  const start = await request(app).post("/v1/auth/registration/start").send({ phone, locale: "fr" });
  expect(start.status).toBe(202);
  return request(app)
    .post("/v1/auth/registration/complete")
    .send({
      challengeId: start.body.challengeId,
      code: sms.lastCode(phone),
      phone,
      password: PASSWORD,
      countryOfResidence: "SN",
      preferredLocale: "fr",
      client,
    });
}

async function webLogin(phone: string): Promise<request.Response> {
  const start = await request(app).post("/v1/auth/login").send({ phone, password: PASSWORD, client: { type: "web" } });
  expect(start.body).toMatchObject({ status: "second_factor_required", method: "sms_otp" });
  return request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: sms.lastCode(phone) });
}

afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("inscription", () => {
  it("crée un compte web vérifié et une session de niveau 2", async () => {
    const phone = newSenegalPhone();
    const response = await register(phone);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "authenticated", deviceId: null });
    expect(response.body.refreshToken).toMatch(/^rt_/);

    const sessions = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${response.body.accessToken}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0]).toMatchObject({ audience: "web", current: true });

    const user = await owner.query<{ status: string; phone_enc: Buffer; password_hash: string }>(
      "SELECT status, phone_enc, password_hash FROM identity.users WHERE id = $1",
      [response.body.userId],
    );
    expect(user.rows[0]?.status).toBe("active");
    // Le numéro n'est jamais stocké en clair.
    expect(user.rows[0]?.phone_enc.includes(Buffer.from(phone.slice(4)))).toBe(false);
    expect(user.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(sms.messages.find((message) => message.to === phone)?.body).toMatch(/Ne le communiquez jamais/);
  });

  it("répond à l'identique pour un numéro déjà inscrit et prévient son titulaire", async () => {
    const phone = newSenegalPhone();
    expect((await register(phone)).status).toBe(201);
    const before = sms.messages.length;
    const again = await request(app).post("/v1/auth/registration/start").send({ phone, locale: "fr" });
    expect(again.status).toBe(202);
    expect(Object.keys(again.body as Record<string, unknown>).sort()).toEqual(["challengeId", "expiresAt"]);
    const notice = sms.messages.slice(before).find((message) => message.to === phone);
    expect(notice?.body).toMatch(/déjà un compte/);
    expect(notice?.body).not.toMatch(/\d{6}/);
  });

  it("limite les tentatives de code puis expire le défi", async () => {
    const phone = newSenegalPhone();
    const start = await request(app).post("/v1/auth/registration/start").send({ phone, locale: "fr" });
    const good = sms.lastCode(phone);
    const wrong = good === "000000" ? "111111" : "000000";
    const attempt = (code: string) =>
      request(app).post("/v1/auth/registration/complete").send({
        challengeId: start.body.challengeId, code, phone, password: PASSWORD, countryOfResidence: "SN", preferredLocale: "fr", client: { type: "web" },
      });
    for (let index = 0; index < 4; index += 1) {
      const response = await attempt(wrong);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("INVALID_VERIFICATION_CODE");
    }
    expect((await attempt(wrong)).body.code).toBe("VERIFICATION_EXPIRED");
    // Même le bon code est refusé une fois les tentatives épuisées.
    expect((await attempt(good)).status).toBe(410);
  });

  it("refuse un code valide présenté pour un autre numéro", async () => {
    const phone = newSenegalPhone();
    const start = await request(app).post("/v1/auth/registration/start").send({ phone, locale: "fr" });
    const response = await request(app).post("/v1/auth/registration/complete").send({
      challengeId: start.body.challengeId, code: sms.lastCode(phone), phone: newSenegalPhone(), password: PASSWORD,
      countryOfResidence: "SN", preferredLocale: "fr", client: { type: "web" },
    });
    expect(response.status).toBe(422);
  });

  it("refuse un mot de passe faible avant de consommer le code", async () => {
    const phone = newSenegalPhone();
    const start = await request(app).post("/v1/auth/registration/start").send({ phone, locale: "fr" });
    const weak = await request(app).post("/v1/auth/registration/complete").send({
      challengeId: start.body.challengeId, code: sms.lastCode(phone), phone, password: "court", countryOfResidence: "SN", preferredLocale: "fr", client: { type: "web" },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.issues[0].path).toBe("body.password");
  });

  it("enregistre un appareil mobile attesté et lie le jeton à l'appareil", async () => {
    const phone = newSenegalPhone();
    const device = new TestDevice("ES256");
    const response = await register(phone, { type: "mobile", device: await deviceRegistration(device) });
    expect(response.status).toBe(201);
    expect(response.body.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await owner.query<{ attestation_type: string; trusted_at: Date | null }>(
      "SELECT attestation_type, trusted_at FROM identity.devices WHERE id = $1",
      [response.body.deviceId],
    );
    expect(stored.rows[0]).toMatchObject({ attestation_type: "app_attest" });
    expect(stored.rows[0]?.trusted_at).not.toBeNull();
    const payload = JSON.parse(Buffer.from((response.body.accessToken as string).split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ aud: "mobile", did: response.body.deviceId, aal: 2 });
  });

  it("refuse un appareil dont l'attestation échoue, et un défi d'appareil réutilisé", async () => {
    const rejected = await register(newSenegalPhone(), { type: "mobile", device: await deviceRegistration(new TestDevice(), "rejected") });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe("DEVICE_ATTESTATION_FAILED");

    const device = new TestDevice();
    const registration = await deviceRegistration(device);
    expect((await register(newSenegalPhone(), { type: "mobile", device: registration })).status).toBe(201);
    const replay = await register(newSenegalPhone(), { type: "mobile", device: registration });
    expect(replay.status).toBe(410);
  });
});

describe("connexion", () => {
  let phone: string;

  beforeAll(async () => {
    phone = newSenegalPhone();
    expect((await register(phone)).status).toBe(201);
  });

  it("exige un second facteur SMS sur le web", async () => {
    const response = await webLogin(phone);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("authenticated");
  });

  it("répond de façon identique pour un mot de passe faux et un numéro inconnu", async () => {
    const wrong = await request(app).post("/v1/auth/login").send({ phone, password: "Mauvais-Mot-De-Passe-1", client: { type: "web" } });
    const unknown = await request(app).post("/v1/auth/login").send({ phone: newSenegalPhone(), password: PASSWORD, client: { type: "web" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
    expect({ ...wrong.body, requestId: undefined }).toEqual({ ...unknown.body, requestId: undefined });
  });

  it("verrouille le compte après cinq échecs, même avec le bon mot de passe ensuite", async () => {
    const victim = newSenegalPhone();
    expect((await register(victim)).status).toBe(201);
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await request(app).post("/v1/auth/login").send({ phone: victim, password: `Faux-${index}-mot-de-passe`, client: { type: "web" } })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    const locked = await request(app).post("/v1/auth/login").send({ phone: victim, password: PASSWORD, client: { type: "web" } });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
  });

  it("refuse un code SMS faux puis accepte le bon", async () => {
    const start = await request(app).post("/v1/auth/login").send({ phone, password: PASSWORD, client: { type: "web" } });
    const good = sms.lastCode(phone);
    const bad = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: good === "123456" ? "654321" : "123456" });
    expect(bad.status).toBe(422);
    const ok = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: good });
    expect(ok.status).toBe(200);
    const replay = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: good });
    expect(replay.status).toBe(410);
  });

  it("refuse un compte suspendu après vérification du mot de passe", async () => {
    const suspended = newSenegalPhone();
    const created = await register(suspended);
    await owner.query("UPDATE identity.users SET status = 'suspended', suspended_at = now() WHERE id = $1", [created.body.userId]);
    const response = await request(app).post("/v1/auth/login").send({ phone: suspended, password: PASSWORD, client: { type: "web" } });
    expect(response.status).toBe(403);
  });
});

describe("appareil mobile de confiance", () => {
  let phone: string;
  let device: TestDevice;
  let deviceId: string;

  beforeAll(async () => {
    phone = newSenegalPhone();
    device = new TestDevice("ES256");
    const registered = await register(phone, { type: "mobile", device: await deviceRegistration(device) });
    deviceId = registered.body.deviceId as string;
  });

  it("connecte sans SMS lorsque la requête est signée par l'appareil", async () => {
    const body = { phone, password: PASSWORD, client: { type: "mobile", deviceId } };
    const response = await request(app)
      .post("/v1/auth/login")
      .set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/login", body }))
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "authenticated", deviceId });
  });

  it("refuse une connexion non signée ou rejouée", async () => {
    const body = { phone, password: PASSWORD, client: { type: "mobile", deviceId } };
    const unsigned = await request(app).post("/v1/auth/login").send(body);
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.code).toBe("DEVICE_SIGNATURE_INVALID");

    const headers = device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/login", body });
    expect((await request(app).post("/v1/auth/login").set(headers).send(body)).status).toBe(200);
    expect((await request(app).post("/v1/auth/login").set(headers).send(body)).status).toBe(401);
  });

  it("refuse l'appareil d'un client pour le compte d'un autre", async () => {
    const otherPhone = newSenegalPhone();
    expect((await register(otherPhone)).status).toBe(201);
    const body = { phone: otherPhone, password: PASSWORD, client: { type: "mobile", deviceId } };
    const response = await request(app)
      .post("/v1/auth/login")
      .set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/login", body }))
      .send(body);
    expect(response.status).toBe(401);
  });

  it("exige un second facteur pour un nouvel appareil puis l'enregistre", async () => {
    const newDevice = new TestDevice("EdDSA");
    const body = { phone, password: PASSWORD, client: { type: "mobile", device: { ...(await deviceRegistration(newDevice)), platform: "android", attestation: { type: "play_integrity", integrityToken: "t".repeat(150) } } } };
    const start = await request(app).post("/v1/auth/login").send(body);
    expect(start.body.status).toBe("second_factor_required");
    const verified = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: sms.lastCode(phone) });
    expect(verified.status).toBe(200);
    expect(verified.body.deviceId).not.toBe(deviceId);
    const devices = await request(app).get("/v1/auth/devices").set("Authorization", `Bearer ${verified.body.accessToken}`);
    expect(devices.body.devices).toHaveLength(2);
  });

  it("exige la signature de l'appareil pour renouveler une session mobile", async () => {
    const body = { phone, password: PASSWORD, client: { type: "mobile", deviceId } };
    const login = await request(app).post("/v1/auth/login").set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/login", body })).send(body);
    const refreshBody = { refreshToken: login.body.refreshToken as string };
    const unsigned = await request(app).post("/v1/auth/token/refresh").send(refreshBody);
    expect(unsigned.status).toBe(401);
    const signed = await request(app)
      .post("/v1/auth/token/refresh")
      .set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/token/refresh", body: refreshBody }))
      .send(refreshBody);
    expect(signed.status).toBe(200);
  });

  it("révoque les sessions d'un appareil révoqué", async () => {
    const body = { phone, password: PASSWORD, client: { type: "mobile", deviceId } };
    const login = await request(app).post("/v1/auth/login").set(device.signatureHeaders({ deviceId, method: "POST", path: "/v1/auth/login", body })).send(body);
    const web = await webLogin(phone);
    const path = `/v1/auth/devices/${deviceId}`;
    const revoked = await request(app).delete(path).set("Authorization", `Bearer ${web.body.accessToken}`);
    expect(revoked.status).toBe(204);
    expect((await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${login.body.accessToken}`)).status).toBe(401);
  });
});

describe("renouvellement et déconnexion", () => {
  it("fait tourner le jeton de renouvellement et révoque tout en cas de réutilisation", async () => {
    const phone = newSenegalPhone();
    const registered = await register(phone);
    const first = registered.body.refreshToken as string;
    const rotated = await request(app).post("/v1/auth/token/refresh").send({ refreshToken: first });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first);
    expect(rotated.body.sessionId).toBe(registered.body.sessionId);

    // Le jeton d'origine est rejoué (vol présumé).
    expect((await request(app).post("/v1/auth/token/refresh").send({ refreshToken: first })).status).toBe(401);
    // Le successeur légitime est révoqué avec toute la famille, la session aussi.
    expect((await request(app).post("/v1/auth/token/refresh").send({ refreshToken: rotated.body.refreshToken })).status).toBe(401);
    expect((await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${rotated.body.accessToken}`)).status).toBe(401);
    const audit = await owner.query("SELECT 1 FROM audit.events WHERE action = 'auth.refresh_token_reuse_detected' AND target_id = $1", [registered.body.sessionId]);
    expect(audit.rowCount).toBe(1);
  });

  it("refuse un jeton de renouvellement inconnu ou mal formé", async () => {
    expect((await request(app).post("/v1/auth/token/refresh").send({ refreshToken: `rt_${randomBytes(32).toString("base64url")}` })).status).toBe(401);
    expect((await request(app).post("/v1/auth/token/refresh").send({ refreshToken: "n'importe quoi" })).status).toBe(401);
  });

  it("invalide immédiatement la session à la déconnexion", async () => {
    const registered = await register(newSenegalPhone());
    const auth = `Bearer ${registered.body.accessToken}`;
    expect((await request(app).post("/v1/auth/logout").set("Authorization", auth).send({})).status).toBe(204);
    expect((await request(app).get("/v1/auth/sessions").set("Authorization", auth)).status).toBe(401);
    expect((await request(app).post("/v1/auth/token/refresh").send({ refreshToken: registered.body.refreshToken })).status).toBe(401);
  });

  it("révoque les autres sessions", async () => {
    const phone = newSenegalPhone();
    const first = await register(phone);
    const second = await webLogin(phone);
    const result = await request(app).post("/v1/auth/sessions/revoke-others").set("Authorization", `Bearer ${second.body.accessToken}`).send({});
    expect(result.body).toEqual({ revoked: 1 });
    expect((await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${first.body.accessToken}`)).status).toBe(401);
    expect((await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${second.body.accessToken}`)).status).toBe(200);
  });
});

describe("double authentification TOTP", () => {
  it("s'active par confirmation, remplace le SMS et refuse le rejeu d'un code", async () => {
    const phone = newSenegalPhone();
    const registered = await register(phone);
    const auth = `Bearer ${registered.body.accessToken}`;
    const setup = await request(app).post("/v1/auth/mfa/totp/setup").set("Authorization", auth).send({});
    expect(setup.status).toBe(201);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/TransfertPlus/);
    const secret = base32Decode(setup.body.secret as string);
    const step = timeStep(Date.now() / 1000);

    expect((await request(app).post("/v1/auth/mfa/totp/confirm").set("Authorization", auth).send({ code: "000000" === hotp(secret, step) ? "111111" : "000000" })).status).toBe(422);
    expect((await request(app).post("/v1/auth/mfa/totp/confirm").set("Authorization", auth).send({ code: hotp(secret, step) })).status).toBe(204);

    const smsBefore = sms.messages.length;
    const start = await request(app).post("/v1/auth/login").send({ phone, password: PASSWORD, client: { type: "web" } });
    expect(start.body.method).toBe("totp");
    expect(sms.messages.length).toBe(smsBefore);
    const nextCode = hotp(secret, step + 1);
    const verified = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: start.body.loginChallengeId, code: nextCode });
    expect(verified.status).toBe(200);

    const again = await request(app).post("/v1/auth/login").send({ phone, password: PASSWORD, client: { type: "web" } });
    const replay = await request(app).post("/v1/auth/login/verify").send({ loginChallengeId: again.body.loginChallengeId, code: nextCode });
    expect(replay.status).toBe(422);
  });
});

describe("passkeys (site web)", () => {
  it("enregistre une passkey puis connecte sans mot de passe", async () => {
    const phone = newSenegalPhone();
    const registered = await register(phone);
    const auth = `Bearer ${registered.body.accessToken}`;
    const authenticator = new SoftwareAuthenticator(config.auth.webauthn.rpId, WEB_ORIGIN);

    const options = await request(app).post("/v1/auth/passkeys/registration/options").set("Authorization", auth).send({});
    expect(options.status).toBe(201);
    expect(options.body.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const credential = authenticator.register(options.body.options as { challenge: string; user: { id: string } });
    const verified = await request(app)
      .post("/v1/auth/passkeys/registration/verify")
      .set("Authorization", auth)
      .send({ challengeId: options.body.challengeId, nickname: "MacBook", response: credential });
    expect(verified.status).toBe(201);

    const loginOptions = await request(app).post("/v1/auth/passkeys/authentication/options").send({});
    const assertion = authenticator.authenticate(loginOptions.body.options as { challenge: string });
    const login = await request(app).post("/v1/auth/passkeys/authentication/verify").send({ challengeId: loginOptions.body.challengeId, response: assertion });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ status: "authenticated", userId: registered.body.userId, deviceId: null });

    // Défi à usage unique.
    const replay = await request(app).post("/v1/auth/passkeys/authentication/verify").send({ challengeId: loginOptions.body.challengeId, response: assertion });
    expect(replay.status).toBe(410);
  });

  it("refuse une assertion émise pour un autre site (hameçonnage)", async () => {
    const registered = await register(newSenegalPhone());
    const authenticator = new SoftwareAuthenticator(config.auth.webauthn.rpId, WEB_ORIGIN);
    const options = await request(app).post("/v1/auth/passkeys/registration/options").set("Authorization", `Bearer ${registered.body.accessToken}`).send({});
    await request(app)
      .post("/v1/auth/passkeys/registration/verify")
      .set("Authorization", `Bearer ${registered.body.accessToken}`)
      .send({ challengeId: options.body.challengeId, response: authenticator.register(options.body.options as { challenge: string; user: { id: string } }) });
    const loginOptions = await request(app).post("/v1/auth/passkeys/authentication/options").send({});
    const phished = authenticator.authenticate(loginOptions.body.options as { challenge: string }, { origin: "https://transfertplus-login.evil.example" });
    const response = await request(app).post("/v1/auth/passkeys/authentication/verify").send({ challengeId: loginOptions.body.challengeId, response: phished });
    expect(response.status).toBe(401);
  });

  it("réserve l'enregistrement de passkey aux sessions web", async () => {
    const registered = await register(newSenegalPhone(), { type: "mobile", device: await deviceRegistration(new TestDevice()) });
    const response = await request(app).post("/v1/auth/passkeys/registration/options").set("Authorization", `Bearer ${registered.body.accessToken}`).send({});
    expect(response.status).toBe(401);
  });
});

describe("traçabilité", () => {
  it("chaîne d'audit intacte après tous les parcours", async () => {
    const problems = await owner.query("SELECT * FROM audit.verify_chain()");
    expect(problems.rows).toEqual([]);
    const actions = await owner.query<{ action: string }>("SELECT DISTINCT action FROM audit.events ORDER BY action");
    expect(actions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["auth.registered", "auth.login_succeeded", "auth.login_failed", "auth.logout", "auth.totp_enabled", "auth.passkey_registered", "auth.device_revoked"]),
    );
  });
});
