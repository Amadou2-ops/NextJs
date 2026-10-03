import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { Encoder } from "cbor-x";

// CBOR canonique WebAuthn : chaînes d'octets sans balise, tailles minimales.
const cbor = new Encoder({ useRecords: false, tagUint8Array: false, variableMapSize: true, mapsAsObjects: true });
const encode = (value: unknown): Buffer => {
  const bytes = Buffer.from(cbor.encode(value));
  // cbor-x préfixe les Map à clés non textuelles par la balise 259 (0xd9 0x0103) ;
  // une clé COSE est une map CBOR brute.
  return value instanceof Map && bytes.subarray(0, 3).equals(Buffer.from([0xd9, 0x01, 0x03])) ? bytes.subarray(3) : bytes;
};

/**
 * Authentificateur WebAuthn logiciel (tests) : produit des réponses
 * d'enregistrement (attestation « none ») et d'authentification au format
 * exact d'un navigateur, avec une vraie clé ECDSA P-256 et de vraies
 * signatures. Vérification de présence et d'identification (UP + UV).
 */
export class SoftwareAuthenticator {
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Buffer;
  readonly credentialId = randomBytes(32);
  private signCount = 0;
  private userHandle: Buffer | undefined;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.cosePublicKey = Buffer.from(
      encode(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x ?? "", "base64url")],
          [-3, Buffer.from(jwk.y ?? "", "base64url")],
        ]),
      ),
    );
  }

  private rpIdHash(): Buffer {
    return createHash("sha256").update(this.rpId).digest();
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }), "utf8");
  }

  register(options: { readonly challenge: string; readonly user: { readonly id: string } }): Record<string, unknown> {
    this.userHandle = Buffer.from(options.user.id, "base64url");
    const counter = Buffer.alloc(4);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x45]), counter, Buffer.alloc(16), credentialIdLength, this.credentialId, this.cosePublicKey]);
    const attestationObject = Buffer.from(encode({ fmt: "none", attStmt: {}, authData }));
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge).toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  authenticate(options: { readonly challenge: string }, overrides: { readonly origin?: string } = {}): Record<string, unknown> {
    this.signCount += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x05]), counter]);
    const clientDataJSON =
      overrides.origin === undefined
        ? this.clientData("webauthn.get", options.challenge)
        : Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), { key: this.privateKey, dsaEncoding: "der" });
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        ...(this.userHandle === undefined ? {} : { userHandle: this.userHandle.toString("base64url") }),
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }
}
