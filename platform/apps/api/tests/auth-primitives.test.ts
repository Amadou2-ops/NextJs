import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessTokenVerifier } from "../src/auth/accessToken.js";
import { DeviceBindingService, DeviceSignatureError } from "../src/modules/auth/deviceBinding.service.js";
import { createPwnedPasswordsChecker, PasswordService } from "../src/modules/auth/password.service.js";
import { hashRefreshToken, isWellFormedRefreshToken, TokenService } from "../src/modules/auth/token.service.js";
import { base32Decode, base32Encode, hotp, timeStep, totpProvisioningUri, verifyTotp } from "../src/modules/auth/totp.js";
import { ValidationError } from "../src/lib/errors.js";
import { TestDevice } from "./support/device.js";
import { buildTestConfig, createApiPool, createOwnerPool, createTestKeys, seedCustomer } from "./support/fixtures.js";

describe("TOTP (RFC 6238, annexe B, SHA-1)", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t=%i → %s", (seconds, expected) => {
    expect(hotp(secret, timeStep(seconds), 8)).toBe(expected);
  });

  it("accepte le pas courant et ses voisins, refuse au-delà", () => {
    const now = 1_800_000_000_000;
    const step = timeStep(now / 1000);
    expect(verifyTotp(secret, hotp(secret, step), { nowMs: now })).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), { nowMs: now })).toBeUndefined();
    expect(verifyTotp(secret, "12345", { nowMs: now })).toBeUndefined();
  });

  it("refuse un pas déjà utilisé (anti-rejeu)", () => {
    const now = 1_800_000_000_000;
    const step = timeStep(now / 1000);
    expect(verifyTotp(secret, hotp(secret, step), { nowMs: now, lastUsedStep: step })).toBeUndefined();
    expect(verifyTotp(secret, hotp(secret, step - 1), { nowMs: now, lastUsedStep: step })).toBeUndefined();
  });

  it("encode le secret en base32 et produit une URI otpauth", () => {
    const random = randomBytes(20);
    expect(base32Decode(base32Encode(random)).equals(random)).toBe(true);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    const uri = new URL(totpProvisioningUri({ secret: random, issuer: "TransfertPlus", accountLabel: "Client 100000001" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(base32Encode(random));
    expect(uri.searchParams.get("period")).toBe("30");
  });
});

describe("mots de passe", () => {
  const service = new PasswordService(undefined);

  it("hache en Argon2id et vérifie", async () => {
    const hash = await service.hash("Correct-Horse-Battery-42");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await service.verify(hash, "Correct-Horse-Battery-42")).toBe(true);
    expect(await service.verify(hash, "correct-horse-battery-42")).toBe(false);
    expect(await service.verify("$2b$10$bcrypt", "x")).toBe(false);
    expect(service.needsRehash(hash)).toBe(false);
    expect(service.needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe(true);
  });

  it.each([
    ["trop court", "Abc-123"],
    ["répétitif", "aaaaaaaaaaaa"],
    ["suite clavier", "azertyuiop123"],
    ["contient le numéro", "Mon-771234567-Secret"],
  ])("refuse un mot de passe %s", async (_label, password) => {
    await expect(service.assertAcceptable(password, { phoneE164: "+221771234567" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuse un mot de passe présent dans une fuite publique", async () => {
    const withBreach = new PasswordService(() => Promise.resolve(true));
    await expect(withBreach.assertAcceptable("Une-Phrase-Assez-Longue-9", {})).rejects.toThrow(ValidationError);
    await expect(service.assertAcceptable("Une-Phrase-Assez-Longue-9", {})).resolves.toBeUndefined();
  });

  it("n'envoie que le préfixe SHA-1 à Have I Been Pwned (k-anonymat)", async () => {
    const password = "P@ssw0rd-de-test-123";
    const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
    const requested: string[] = [];
    const fakeFetch = ((url: string) => {
      requested.push(url);
      return Promise.resolve(new Response(`0000000000000000000000000000000000A:0\r\n${digest.slice(5)}:42\r\n`, { status: 200 }));
    }) as unknown as typeof fetch;
    const checker = createPwnedPasswordsChecker(fakeFetch);
    expect(await checker(password)).toBe(true);
    expect(requested).toEqual([`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`]);
    expect(requested[0]).not.toContain(digest.slice(5));
  });

  it("reste disponible si Have I Been Pwned ne répond pas", async () => {
    const failing = (() => Promise.reject(new Error("réseau"))) as unknown as typeof fetch;
    let reported = false;
    expect(await createPwnedPasswordsChecker(failing, () => (reported = true))("x".repeat(12))).toBe(false);
    expect(reported).toBe(true);
  });
});

describe("jetons", () => {
  it("émet un jeton d'accès accepté par le vérificateur", async () => {
    const keys = await createTestKeys();
    const config = buildTestConfig(keys);
    const tokens = new TokenService(config.jwt.issuer, config.auth.customerSigningKey);
    const verifier = new AccessTokenVerifier(config.jwt.issuer, config.jwt.customerJwks, config.jwt.adminJwks);
    const issued = await tokens.issueAccessToken({
      subjectId: "6f1c2a8e-3b4d-4c5e-8f9a-0b1c2d3e4f5a",
      sessionId: "7a2b3c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d",
      audience: "mobile",
      assuranceLevel: 2,
      deviceId: "8b3c4d5e-6f7a-4b2c-8d9e-0f1a2b3c4d5e",
    });
    const claims = await verifier.verify(issued.token, ["mobile", "web"]);
    expect(claims).toMatchObject({ audience: "mobile", assuranceLevel: 2, deviceId: "8b3c4d5e-6f7a-4b2c-8d9e-0f1a2b3c4d5e" });
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    await expect(
      tokens.issueAccessToken({ subjectId: "6f1c2a8e-3b4d-4c5e-8f9a-0b1c2d3e4f5a", sessionId: "7a2b3c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d", audience: "mobile", assuranceLevel: 2, deviceId: null }),
    ).rejects.toThrow();
  });

  it("génère des jetons de renouvellement opaques et uniques", async () => {
    const keys = await createTestKeys();
    const tokens = new TokenService("https://auth.test", keys.customer.privateJwk);
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(isWellFormedRefreshToken(a.token)).toBe(true);
    expect(hashRefreshToken(a.token).equals(a.sha256)).toBe(true);
    expect(isWellFormedRefreshToken("rt_court")).toBe(false);
  });
});

describe("signature des requêtes par l'appareil", () => {
  const keysPromise = createTestKeys();
  const owner = createOwnerPool();
  let apiPool: ReturnType<typeof createApiPool>;
  let binding: DeviceBindingService;

  beforeAll(async () => {
    apiPool = createApiPool(buildTestConfig(await keysPromise));
    binding = new DeviceBindingService(apiPool);
  });

  afterAll(async () => {
    await apiPool.end();
    await owner.end();
  });

  async function enrolledDevice(algorithm: "ES256" | "EdDSA") {
    const customer = await seedCustomer(owner);
    const device = new TestDevice(algorithm);
    await owner.query("UPDATE identity.devices SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [customer.deviceId]);
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO identity.devices (user_id, platform, device_name, public_key_spki, public_key_algorithm, attestation_type,
                                     attestation_verified_at, trusted_at)
       VALUES ($1, 'android', 'Pixel de test', $2, $3, 'play_integrity', now(), now()) RETURNING id`,
      [customer.userId, device.publicKeySpki, algorithm],
    );
    return { userId: customer.userId, deviceId: inserted.rows[0]!.id, device };
  }

  function parts(headers: Record<string, string>, body: unknown, path = "/v1/transfers") {
    return {
      method: "POST",
      pathWithQuery: path,
      rawBody: Buffer.from(JSON.stringify(body)),
      deviceId: headers["X-Device-Id"],
      timestamp: headers["X-Device-Signature-Timestamp"],
      counter: headers["X-Device-Counter"],
      signature: headers["X-Device-Signature"],
    };
  }

  it.each(["ES256", "EdDSA"] as const)("vérifie une signature %s et refuse son rejeu", async (algorithm) => {
    const { userId, deviceId, device } = await enrolledDevice(algorithm);
    const body = { amount: "10000" };
    const headers = device.signatureHeaders({ deviceId, method: "POST", path: "/v1/transfers", body });
    await expect(binding.verify(parts(headers, body), { deviceId, userId })).resolves.toEqual({ deviceId, userId });
    await expect(binding.verify(parts(headers, body), { deviceId, userId })).rejects.toMatchObject({ internalContext: { reason: "replayed_counter" } });
  });

  it("refuse un corps, un chemin ou un horodatage altérés", async () => {
    const { userId, deviceId, device } = await enrolledDevice("ES256");
    const headers = device.signatureHeaders({ deviceId, method: "POST", path: "/v1/transfers", body: { amount: "100" } });
    await expect(binding.verify(parts(headers, { amount: "999" }), { deviceId, userId })).rejects.toMatchObject({ internalContext: { reason: "bad_signature" } });
    await expect(binding.verify(parts(headers, { amount: "100" }, "/v1/other"), { deviceId, userId })).rejects.toMatchObject({ internalContext: { reason: "bad_signature" } });
    const stale = device.signatureHeaders({ deviceId, method: "POST", path: "/v1/transfers", body: {}, timestampMs: Date.now() - 120_000 });
    await expect(binding.verify(parts(stale, {}), { deviceId, userId })).rejects.toMatchObject({ internalContext: { reason: "timestamp_out_of_tolerance" } });
  });

  it("refuse la clé d'un autre appareil ou d'un autre client", async () => {
    const first = await enrolledDevice("ES256");
    const second = await enrolledDevice("ES256");
    const forged = second.device.signatureHeaders({ deviceId: first.deviceId, method: "POST", path: "/v1/transfers", body: {} });
    await expect(binding.verify(parts(forged, {}), { deviceId: first.deviceId, userId: first.userId })).rejects.toBeInstanceOf(DeviceSignatureError);
    const own = second.device.signatureHeaders({ deviceId: second.deviceId, method: "POST", path: "/v1/transfers", body: {} });
    await expect(binding.verify(parts(own, {}), { userId: first.userId })).rejects.toMatchObject({ internalContext: { reason: "device_of_other_user" } });
  });

  it("refuse un appareil révoqué", async () => {
    const { userId, deviceId, device } = await enrolledDevice("EdDSA");
    await owner.query("UPDATE identity.devices SET revoked_at = now(), revoked_reason = 'perdu' WHERE id = $1", [deviceId]);
    const headers = device.signatureHeaders({ deviceId, method: "POST", path: "/v1/transfers", body: {} });
    await expect(binding.verify(parts(headers, {}), { deviceId, userId })).rejects.toMatchObject({ internalContext: { reason: "unknown_or_revoked_device" } });
  });
});
