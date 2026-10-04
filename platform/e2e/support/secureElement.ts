import "reflect-metadata";

import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import type { KeyObject } from "node:crypto";

import * as x509 from "@peculiar/x509";
import { encode } from "cbor-x";

/**
 * Composant sécurisé de l'appareil pour le parcours mobile : remplace la
 * Secure Enclave et le service App Attest d'Apple, absents hors d'un iPhone.
 *
 *   - clé de l'appareil P-256 (SPKI DER, signatures ECDSA / SHA-256 DER),
 *     comme DeviceSecurityChannel.swift ;
 *   - attestation au format App Attest exact (CBOR, chaîne x5c, extension de
 *     nonce, authData), signée par une autorité racine de TEST que l'API de
 *     la pile accepte en développement seulement
 *     (APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH, refusée en préproduction et en
 *     production par la configuration).
 *
 * Tout le reste — vérification de l'attestation, enregistrement de
 * l'appareil, signatures de requêtes, compteur — est le code de production.
 */

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

type X509KeyPair = Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0]["keys"];

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;
const NONCE_OID = "1.2.840.113635.100.8.2";
const PRODUCTION_AAGUID = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]);

function sha256(...parts: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

async function generateP256(): Promise<X509KeyPair> {
  const pair: unknown = await webcrypto.subtle.generateKey(ECDSA_P256, true, ["sign", "verify"]);
  return pair as X509KeyPair;
}

export class TestSecureElement {
  private deviceKey: { readonly privateKey: KeyObject; readonly spki: Buffer } | null = null;

  private constructor(
    private readonly appId: string,
    readonly rootPem: string,
    private readonly intermediate: x509.X509Certificate,
    private readonly intermediateKeys: X509KeyPair,
  ) {}

  /** Autorité de test (racine → intermédiaire), comme la hiérarchie Apple. */
  static async create(appId: string): Promise<TestSecureElement> {
    const notBefore = new Date(Date.now() - 86_400_000);
    const notAfter = new Date(Date.now() + 30 * 86_400_000);
    const rootKeys = await generateP256();
    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=TransfertPlus E2E App Attestation Root CA, O=Tests de bout en bout",
      notBefore,
      notAfter,
      keys: rootKeys,
      signingAlgorithm: SIGNING,
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
    });
    const intermediateKeys = await generateP256();
    const intermediate = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      subject: "CN=TransfertPlus E2E App Attestation CA 1, O=Tests de bout en bout",
      issuer: root.subject,
      notBefore,
      notAfter,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      signingAlgorithm: SIGNING,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
    });
    return new TestSecureElement(appId, root.toString("pem"), intermediate, intermediateKeys);
  }

  createKey(): Buffer {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    this.deviceKey = { privateKey, spki };
    return spki;
  }

  publicKey(): Buffer | null {
    return this.deviceKey?.spki ?? null;
  }

  deleteKey(): void {
    this.deviceKey = null;
  }

  /** Signature ECDSA P-256 / SHA-256 au format DER, comme SecKeyCreateSignature. */
  sign(message: Buffer): Buffer {
    if (this.deviceKey === null) throw new Error("clé de l'appareil absente");
    return sign("sha256", message, { key: this.deviceKey.privateKey, dsaEncoding: "der" });
  }

  /**
   * Attestation App Attest d'une clé App Attest neuve, liée au condensat
   * fourni par l'application (défi serveur ‖ empreinte de la clé de l'appareil).
   */
  async attest(clientDataHash: Buffer): Promise<{ readonly keyId: string; readonly attestationObject: string }> {
    const appAttestKeys = await generateP256();
    const rawPublicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", appAttestKeys.publicKey));
    const keyId = sha256(rawPublicKey);
    const counter = Buffer.alloc(4);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(32);
    const coseKey = Buffer.from(encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, rawPublicKey.subarray(1, 33)], [-3, rawPublicKey.subarray(33)]])));
    const authData = Buffer.concat([sha256(Buffer.from(this.appId, "utf8")), Buffer.from([0x40]), counter, PRODUCTION_AAGUID, credentialIdLength, keyId, coseKey]);
    const nonce = sha256(authData, clientDataHash);
    // extnValue = SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
    const extensionValue = Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce]);
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "03",
      subject: `CN=${keyId.toString("hex")}, OU=AAA Certification, O=Tests de bout en bout`,
      issuer: this.intermediate.subject,
      notBefore: new Date(Date.now() - 3_600_000),
      notAfter: new Date(Date.now() + 3 * 86_400_000),
      publicKey: appAttestKeys.publicKey,
      signingKey: this.intermediateKeys.privateKey,
      signingAlgorithm: SIGNING,
      extensions: [new x509.Extension(NONCE_OID, false, extensionValue)],
    });
    const attestationObject = encode({
      fmt: "apple-appattest",
      attStmt: { x5c: [Buffer.from(leaf.rawData), Buffer.from(this.intermediate.rawData)], receipt: Buffer.from("receipt") },
      authData,
    });
    return { keyId: keyId.toString("base64"), attestationObject: Buffer.from(attestationObject).toString("base64") };
  }
}
