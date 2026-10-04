import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";

import { decode } from "cbor-x";

import { AttestationError, attestationClientDataHash } from "./types.js";
import type { AttestationInput, AttestationResult, AttestationVerifier } from "./types.js";

/**
 * Vérification d'une attestation Apple App Attest (format « apple-appattest »),
 * conformément à la procédure Apple « Validating apps that connect to your
 * server » :
 *   1. chaîne x5c (certificat de clé ← intermédiaire ← racine Apple) valide ;
 *   2. nonce = SHA-256(authData ‖ clientDataHash) présent dans l'extension
 *      1.2.840.113635.100.8.2 du certificat de clé ;
 *   3. keyId = SHA-256(clé publique du certificat) ;
 *   4. authData : rpIdHash = SHA-256(App ID), compteur = 0, AAGUID de
 *      production (ou de développement si explicitement autorisé),
 *      identifiant de credential = keyId.
 */

const NONCE_EXTENSION_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop", "ascii");
const MAX_ATTESTATION_BYTES = 16 * 1024;

interface AttestationObject {
  readonly fmt: string;
  readonly attStmt: { readonly x5c: readonly Uint8Array[]; readonly receipt?: Uint8Array };
  readonly authData: Uint8Array;
}

function sha256(...parts: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function isAttestationObject(value: unknown): value is AttestationObject {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const attStmt = candidate["attStmt"] as Record<string, unknown> | undefined;
  return (
    typeof candidate["fmt"] === "string" &&
    candidate["authData"] instanceof Uint8Array &&
    typeof attStmt === "object" &&
    Array.isArray(attStmt["x5c"]) &&
    (attStmt["x5c"] as unknown[]).every((item) => item instanceof Uint8Array)
  );
}

/** Lecture d'un élément DER (tag, longueur, contenu). */
function readTlv(buffer: Buffer, offset: number): { tag: number; content: Buffer; next: number } {
  const tag = buffer[offset];
  let lengthByte = buffer[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new AttestationError("DER tronqué");
  let length: number;
  let cursor = offset + 2;
  if (lengthByte < 0x80) {
    length = lengthByte;
  } else {
    const octets = lengthByte & 0x7f;
    if (octets === 0 || octets > 3) throw new AttestationError("longueur DER non supportée");
    length = 0;
    for (let index = 0; index < octets; index += 1) {
      lengthByte = buffer[cursor];
      if (lengthByte === undefined) throw new AttestationError("DER tronqué");
      length = (length << 8) | lengthByte;
      cursor += 1;
    }
  }
  const end = cursor + length;
  if (end > buffer.length) throw new AttestationError("DER tronqué");
  return { tag, content: buffer.subarray(cursor, end), next: end };
}

/** Extrait le nonce de l'extension App Attest du certificat de clé. */
export function extractAppAttestNonce(certificateDer: Buffer): Buffer {
  const position = certificateDer.indexOf(NONCE_EXTENSION_OID);
  if (position === -1) throw new AttestationError("extension de nonce App Attest absente");
  let cursor = position + NONCE_EXTENSION_OID.length;
  let element = readTlv(certificateDer, cursor);
  if (element.tag === 0x01) {
    // Champ « critical » optionnel.
    cursor = element.next;
    element = readTlv(certificateDer, cursor);
  }
  if (element.tag !== 0x04) throw new AttestationError("extension App Attest mal formée (OCTET STRING attendu)");
  const sequence = readTlv(element.content, 0);
  if (sequence.tag !== 0x30) throw new AttestationError("extension App Attest mal formée (SEQUENCE attendue)");
  const tagged = readTlv(sequence.content, 0);
  if (tagged.tag !== 0xa1) throw new AttestationError("extension App Attest mal formée ([1] attendu)");
  const nonce = readTlv(tagged.content, 0);
  if (nonce.tag !== 0x04 || nonce.content.length !== 32) throw new AttestationError("nonce App Attest invalide");
  return Buffer.from(nonce.content);
}

function rawEcPoint(certificate: X509Certificate): Buffer {
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  const details = certificate.publicKey.asymmetricKeyDetails;
  if (certificate.publicKey.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") {
    throw new AttestationError("la clé App Attest doit être une clé EC P-256");
  }
  return spki.subarray(spki.length - 65);
}

export interface AppAttestOptions {
  /** App IDs autorisés : « TEAMID.bundle.identifier ». */
  readonly appIds: readonly string[];
  readonly allowDevelopment: boolean;
  readonly rootCertificate: X509Certificate;
  readonly now?: () => Date;
}

export class AppAttestVerifier implements AttestationVerifier {
  private readonly rpIdHashes: readonly { readonly appId: string; readonly hash: Buffer }[];

  constructor(private readonly options: AppAttestOptions) {
    if (options.appIds.length === 0) throw new Error("au moins un App ID est requis");
    this.rpIdHashes = options.appIds.map((appId) => ({ appId, hash: sha256(Buffer.from(appId, "utf8")) }));
  }

  verify(input: AttestationInput): Promise<AttestationResult> {
    try {
      return Promise.resolve(this.verifySync(input));
    } catch (error: unknown) {
      return Promise.reject(error instanceof AttestationError ? error : new AttestationError("attestation App Attest illisible", { cause: error }));
    }
  }

  private verifySync(input: AttestationInput): AttestationResult {
    if (input.evidence.type !== "app_attest") throw new AttestationError("preuve App Attest attendue");
    const keyId = Buffer.from(input.evidence.keyId, "base64");
    if (keyId.length !== 32) throw new AttestationError("keyId App Attest invalide");
    const raw = Buffer.from(input.evidence.attestationObject, "base64");
    if (raw.length === 0 || raw.length > MAX_ATTESTATION_BYTES) throw new AttestationError("objet d'attestation de taille invalide");

    const decoded: unknown = decode(raw);
    if (!isAttestationObject(decoded)) throw new AttestationError("objet d'attestation mal formé");
    if (decoded.fmt !== "apple-appattest") throw new AttestationError(`format d'attestation inattendu : ${decoded.fmt}`);
    if (decoded.attStmt.x5c.length < 2) throw new AttestationError("chaîne de certificats incomplète");

    // 1. Chaîne de certificats.
    const [leafDer, intermediateDer] = decoded.attStmt.x5c;
    if (leafDer === undefined || intermediateDer === undefined) throw new AttestationError("chaîne de certificats incomplète");
    const leaf = new X509Certificate(Buffer.from(leafDer));
    const intermediate = new X509Certificate(Buffer.from(intermediateDer));
    const root = this.options.rootCertificate;
    const now = (this.options.now ?? (() => new Date()))();
    for (const certificate of [leaf, intermediate]) {
      if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
        throw new AttestationError("certificat d'attestation hors période de validité");
      }
    }
    if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) {
      throw new AttestationError("certificat intermédiaire non émis par l'autorité racine Apple");
    }
    if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
      throw new AttestationError("certificat de clé non émis par l'intermédiaire");
    }

    // 2. Nonce.
    const authData = Buffer.from(decoded.authData);
    const clientDataHash = attestationClientDataHash(input.challenge, input.devicePublicKeySpki);
    const expectedNonce = sha256(authData, clientDataHash);
    if (!timingSafeEqual(extractAppAttestNonce(leaf.raw), expectedNonce)) {
      throw new AttestationError("nonce d'attestation incorrect (défi ou clé d'appareil non liés)");
    }

    // 3. keyId = SHA-256(clé publique).
    if (!timingSafeEqual(sha256(rawEcPoint(leaf)), keyId)) throw new AttestationError("keyId ne correspond pas à la clé attestée");

    // 4. Données d'authentification.
    if (authData.length < 55) throw new AttestationError("authData tronqué");
    const rpIdHash = authData.subarray(0, 32);
    const matchedApp = this.rpIdHashes.find((candidate) => timingSafeEqual(candidate.hash, rpIdHash));
    if (matchedApp === undefined) throw new AttestationError("App ID non autorisé");
    const counter = authData.readUInt32BE(33);
    if (counter !== 0) throw new AttestationError("compteur d'attestation non nul");
    const aaguid = authData.subarray(37, 53);
    let environment: "production" | "development";
    if (aaguid.equals(AAGUID_PRODUCTION)) {
      environment = "production";
    } else if (aaguid.equals(AAGUID_DEVELOPMENT) && this.options.allowDevelopment) {
      environment = "development";
    } else {
      throw new AttestationError("environnement App Attest non autorisé");
    }
    const credentialIdLength = authData.readUInt16BE(53);
    const credentialId = authData.subarray(55, 55 + credentialIdLength);
    if (credentialId.length !== 32 || !credentialId.equals(keyId)) throw new AttestationError("identifiant de credential différent du keyId");

    return { type: "app_attest", details: { environment, appId: matchedApp.appId } };
  }
}
