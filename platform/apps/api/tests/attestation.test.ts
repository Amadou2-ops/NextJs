import { generateKeyPairSync, randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { loadAppleAppAttestationRoot } from "../src/modules/auth/attestation/appleRootCa.js";
import { AppAttestVerifier, extractAppAttestNonce } from "../src/modules/auth/attestation/appAttest.js";
import { PlayIntegrityVerifier } from "../src/modules/auth/attestation/playIntegrity.js";
import { AttestationError, attestationClientDataHash, CompositeAttestationVerifier } from "../src/modules/auth/attestation/types.js";
import { createAppAttestation, createTestAuthority } from "./support/appAttest.js";
import type { TestAttestationAuthority } from "./support/appAttest.js";

const APP_ID = "ABCDE12345.com.transfertplus.app";

function deviceKey(): Buffer {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" });
}

describe("racine Apple App Attestation", () => {
  it("est chargée, épinglée et auto-signée", () => {
    const root = loadAppleAppAttestationRoot();
    expect(root.subject).toContain("Apple App Attestation Root CA");
    expect(new Date(root.validTo).getFullYear()).toBe(2045);
  });
});

describe("App Attest", () => {
  let authority: TestAttestationAuthority;
  let verifier: AppAttestVerifier;

  beforeAll(async () => {
    authority = await createTestAuthority();
    verifier = new AppAttestVerifier({ appIds: [APP_ID], allowDevelopment: false, rootCertificate: authority.root });
  });

  it("accepte une attestation conforme liée au défi et à la clé de l'appareil", async () => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: spki });
    await expect(verifier.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "app_attest", ...evidence } })).resolves.toEqual({
      type: "app_attest",
      details: { environment: "production", appId: APP_ID },
    });
  });

  it("extrait le nonce de l'extension 1.2.840.113635.100.8.2", async () => {
    const challenge = randomBytes(32);
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: deviceKey() });
    const { decode } = await import("cbor-x");
    const decoded = decode(Buffer.from(evidence.attestationObject, "base64")) as { attStmt: { x5c: Uint8Array[] } };
    expect(extractAppAttestNonce(Buffer.from(decoded.attStmt.x5c[0]!))).toHaveLength(32);
  });

  it.each([
    ["un autre défi", { nonceChallenge: randomBytes(32) }, /nonce/],
    ["une autre application", { appId: "ZZZZZ99999.com.evil.app" }, /App ID/],
    ["l'environnement de développement", { environment: "development" as const }, /environnement/],
    ["un compteur non nul", { counter: 1 }, /compteur/],
    ["un keyId falsifié", { wrongKeyId: true }, /keyId/],
  ])("refuse une attestation produite pour %s", async (_label, variation, message) => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: spki, ...variation });
    await expect(verifier.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "app_attest", ...evidence } })).rejects.toThrow(message);
  });

  it("refuse si la clé de l'appareil présentée n'est pas celle attestée", async () => {
    const challenge = randomBytes(32);
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: deviceKey() });
    await expect(verifier.verify({ challenge, devicePublicKeySpki: deviceKey(), evidence: { type: "app_attest", ...evidence } })).rejects.toThrow(/nonce/);
  });

  it("accepte le développement uniquement s'il est explicitement autorisé", async () => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: spki, environment: "development" });
    const permissive = new AppAttestVerifier({ appIds: [APP_ID], allowDevelopment: true, rootCertificate: authority.root });
    await expect(permissive.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "app_attest", ...evidence } })).resolves.toMatchObject({
      details: { environment: "development" },
    });
  });

  it("refuse une chaîne émise par une autre autorité (y compris la vraie racine Apple pour un faux)", async () => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const evidence = await createAppAttestation(authority, { appId: APP_ID, challenge, devicePublicKeySpki: spki });
    const apple = new AppAttestVerifier({ appIds: [APP_ID], allowDevelopment: false, rootCertificate: loadAppleAppAttestationRoot() });
    await expect(apple.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "app_attest", ...evidence } })).rejects.toThrow(/racine Apple/);
    const other = await createTestAuthority();
    const foreign = new AppAttestVerifier({ appIds: [APP_ID], allowDevelopment: false, rootCertificate: other.root });
    await expect(foreign.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "app_attest", ...evidence } })).rejects.toThrow(AttestationError);
  });

  it("refuse un objet CBOR invalide", async () => {
    await expect(
      verifier.verify({ challenge: randomBytes(32), devicePublicKeySpki: deviceKey(), evidence: { type: "app_attest", keyId: randomBytes(32).toString("base64"), attestationObject: "AAAA" } }),
    ).rejects.toThrow(AttestationError);
  });
});

describe("Play Integrity", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = {
    type: "service_account" as const,
    client_email: "play-integrity@transfertplus-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const digest = randomBytes(32).toString("base64url");
  const integrityToken = "x".repeat(200);

  function fakeGoogle(payload: (requestHash: string) => unknown, expectedHash: string) {
    const calls: string[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push(url);
      if (url === serviceAccount.token_uri) {
        const body = new URLSearchParams(init.body as string);
        expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        return Promise.resolve(Response.json({ access_token: "ya29.test", expires_in: 3600 }));
      }
      expect(url).toBe("https://playintegrity.googleapis.com/v1/com.transfertplus.app:decodeIntegrityToken");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ya29.test");
      return Promise.resolve(Response.json({ tokenPayloadExternal: payload(expectedHash) }));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  function genuine(requestHash: string) {
    return {
      requestDetails: { requestPackageName: "com.transfertplus.app", requestHash, timestampMillis: String(Date.now()) },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.transfertplus.app", certificateSha256Digest: [digest] },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
      accountDetails: { appLicensingVerdict: "LICENSED" },
    };
  }

  it("accepte un jeton authentique et met en cache le jeton OAuth", async () => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const expectedHash = attestationClientDataHash(challenge, spki).toString("base64url");
    const google = fakeGoogle(genuine, expectedHash);
    const verifier = new PlayIntegrityVerifier({ packageName: "com.transfertplus.app", certificateDigests: [digest], serviceAccount, fetchImpl: google.fetchImpl });
    const input = { challenge, devicePublicKeySpki: spki, evidence: { type: "play_integrity" as const, integrityToken } };
    await expect(verifier.verify(input)).resolves.toMatchObject({ type: "play_integrity", details: { licensing: "LICENSED" } });
    await verifier.verify(input);
    expect(google.calls.filter((url) => url === serviceAccount.token_uri)).toHaveLength(1);
  });

  it.each([
    ["requestHash d'un autre défi", (hash: string) => ({ ...genuine(hash), requestDetails: { ...genuine(hash).requestDetails, requestHash: "autre" } }), /requestHash/],
    ["application non reconnue", (hash: string) => ({ ...genuine(hash), appIntegrity: { ...genuine(hash).appIntegrity, appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }), /non reconnue/],
    ["certificat inconnu", (hash: string) => ({ ...genuine(hash), appIntegrity: { ...genuine(hash).appIntegrity, certificateSha256Digest: ["inconnu"] } }), /certificat/],
    ["appareil compromis", (hash: string) => ({ ...genuine(hash), deviceIntegrity: { deviceRecognitionVerdict: [] } }), /intégrité/],
    ["jeton périmé", (hash: string) => ({ ...genuine(hash), requestDetails: { ...genuine(hash).requestDetails, timestampMillis: String(Date.now() - 3_600_000) } }), /périmé/],
  ])("refuse : %s", async (_label, payload, message) => {
    const challenge = randomBytes(32);
    const spki = deviceKey();
    const google = fakeGoogle(payload, attestationClientDataHash(challenge, spki).toString("base64url"));
    const verifier = new PlayIntegrityVerifier({ packageName: "com.transfertplus.app", certificateDigests: [digest], serviceAccount, fetchImpl: google.fetchImpl });
    await expect(verifier.verify({ challenge, devicePublicKeySpki: spki, evidence: { type: "play_integrity", integrityToken } })).rejects.toThrow(message);
  });
});

describe("aiguillage par plateforme", () => {
  it("refuse une plateforme non configurée", async () => {
    const composite = new CompositeAttestationVerifier(undefined, undefined);
    await expect(
      composite.verify({ challenge: randomBytes(32), devicePublicKeySpki: deviceKey(), evidence: { type: "play_integrity", integrityToken: "x".repeat(200) } }),
    ).rejects.toThrow(/non configurée/);
  });
});
