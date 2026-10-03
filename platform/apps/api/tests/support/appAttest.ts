import "reflect-metadata";

import { createHash, webcrypto, X509Certificate } from "node:crypto";

import * as x509 from "@peculiar/x509";
import { encode } from "cbor-x";

import { attestationClientDataHash } from "../../src/modules/auth/attestation/types.js";

/**
 * Fabrique d'attestations App Attest SYNTHÉTIQUES pour les tests : une
 * autorité racine de test remplace la racine Apple, le reste du format
 * (CBOR, chaîne x5c, extension de nonce, authData) est identique à celui
 * produit par un iPhone. Permet de tester chaque contrôle du vérificateur.
 */

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

/** Paire de clés au type attendu par @peculiar/x509 (types Web Crypto). */
type X509KeyPair = Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0]["keys"];

async function generateP256(): Promise<X509KeyPair> {
  const pair: unknown = await webcrypto.subtle.generateKey(ECDSA_P256, true, ["sign", "verify"]);
  return pair as X509KeyPair;
}

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;
const NONCE_OID = "1.2.840.113635.100.8.2";

function sha256(...parts: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export interface TestAttestationAuthority {
  readonly root: X509Certificate;
  readonly rootKeys: X509KeyPair;
  readonly intermediate: x509.X509Certificate;
  readonly intermediateKeys: X509KeyPair;
}

export async function createTestAuthority(): Promise<TestAttestationAuthority> {
  const notBefore = new Date(Date.now() - 86_400_000);
  const notAfter = new Date(Date.now() + 365 * 86_400_000);
  const rootKeys = await generateP256();
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test App Attestation Root CA, O=Tests",
    notBefore,
    notAfter,
    keys: rootKeys,
    signingAlgorithm: SIGNING,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
  });
  const intermediateKeys = await generateP256();
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test App Attestation CA 1, O=Tests",
    issuer: root.subject,
    notBefore,
    notAfter,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: SIGNING,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
  });
  return { root: new X509Certificate(Buffer.from(root.rawData)), rootKeys, intermediate, intermediateKeys };
}

export interface AttestationOptions {
  readonly appId: string;
  readonly challenge: Buffer;
  readonly devicePublicKeySpki: Buffer;
  readonly environment?: "production" | "development";
  readonly counter?: number;
  /** Altère le keyId annoncé (doit être refusé). */
  readonly wrongKeyId?: boolean;
  /** Nonce calculé sur un autre défi (doit être refusé). */
  readonly nonceChallenge?: Buffer;
}

export async function createAppAttestation(
  authority: TestAttestationAuthority,
  options: AttestationOptions,
): Promise<{ readonly keyId: string; readonly attestationObject: string }> {
  const appAttestKeys = await generateP256();
  const rawPublicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", appAttestKeys.publicKey as unknown as webcrypto.CryptoKey));
  const keyId = sha256(rawPublicKey);

  const aaguid =
    (options.environment ?? "production") === "production"
      ? Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)])
      : Buffer.from("appattestdevelop", "ascii");
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.counter ?? 0);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(32);
  const coseKey = Buffer.from(encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, rawPublicKey.subarray(1, 33)], [-3, rawPublicKey.subarray(33)]])));
  const authData = Buffer.concat([sha256(Buffer.from(options.appId, "utf8")), Buffer.from([0x40]), counter, aaguid, credentialIdLength, keyId, coseKey]);

  const clientDataHash = attestationClientDataHash(options.nonceChallenge ?? options.challenge, options.devicePublicKeySpki);
  const nonce = sha256(authData, clientDataHash);
  // extnValue = SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
  const extensionValue = Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce]);

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03",
    subject: `CN=${keyId.toString("hex")}, OU=AAA Certification, O=Tests`,
    issuer: authority.intermediate.subject,
    notBefore: new Date(Date.now() - 3_600_000),
    notAfter: new Date(Date.now() + 3 * 86_400_000),
    publicKey: appAttestKeys.publicKey,
    signingKey: authority.intermediateKeys.privateKey,
    signingAlgorithm: SIGNING,
    extensions: [new x509.Extension(NONCE_OID, false, extensionValue)],
  });

  const attestationObject = encode({
    fmt: "apple-appattest",
    attStmt: { x5c: [Buffer.from(leaf.rawData), Buffer.from(authority.intermediate.rawData)], receipt: Buffer.from("receipt") },
    authData,
  });
  const announcedKeyId = options.wrongKeyId === true ? sha256(keyId) : keyId;
  return { keyId: announcedKeyId.toString("base64"), attestationObject: Buffer.from(attestationObject).toString("base64") };
}
