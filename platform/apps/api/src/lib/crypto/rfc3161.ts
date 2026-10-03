import { createHash, randomBytes, verify as verifySignature, X509Certificate } from "node:crypto";

import {
  booleanValue,
  children,
  decodeGeneralizedTime,
  decodeInteger,
  decodeOid,
  DerError,
  expectTag,
  integer,
  nullValue,
  objectIdentifier,
  octetString,
  parseDer,
  sequence,
  TAG,
} from "./der.js";
import type { DerNode } from "./der.js";

/**
 * Horodatage qualifié RFC 3161 (Time-Stamp Protocol).
 *
 * Usage : ancrer l'empreinte de tête du registre auprès d'une autorité
 * d'horodatage (TSA) indépendante. Le jeton signé par la TSA prouve que cette
 * empreinte — donc tout l'historique qu'elle résume — existait à la date
 * indiquée. Un administrateur qui réécrirait l'historique ne pourrait pas
 * produire de jeton antérieur correspondant à la chaîne falsifiée.
 *
 * Le jeton est entièrement vérifié avant d'être accepté : statut, empreinte
 * et nonce de la requête, condensat CMS, signature de la TSA, usage étendu
 * « timeStamping » et chaîne de confiance vers les certificats configurés.
 */

const OID = {
  SHA256: "2.16.840.1.101.3.4.2.1",
  SHA384: "2.16.840.1.101.3.4.2.2",
  SHA512: "2.16.840.1.101.3.4.2.3",
  SIGNED_DATA: "1.2.840.113549.1.7.2",
  TST_INFO: "1.2.840.113549.1.9.16.1.4",
  CONTENT_TYPE: "1.2.840.113549.1.9.3",
  MESSAGE_DIGEST: "1.2.840.113549.1.9.4",
  RSA_ENCRYPTION: "1.2.840.113549.1.1.1",
  SHA256_WITH_RSA: "1.2.840.113549.1.1.11",
  SHA384_WITH_RSA: "1.2.840.113549.1.1.12",
  SHA512_WITH_RSA: "1.2.840.113549.1.1.13",
  ECDSA_WITH_SHA256: "1.2.840.10045.4.3.2",
  ECDSA_WITH_SHA384: "1.2.840.10045.4.3.3",
  ECDSA_WITH_SHA512: "1.2.840.10045.4.3.4",
  ED25519: "1.3.101.112",
  KP_TIME_STAMPING: "1.3.6.1.5.5.7.3.8",
} as const;

const DIGESTS: Readonly<Record<string, "sha256" | "sha384" | "sha512">> = {
  [OID.SHA256]: "sha256",
  [OID.SHA384]: "sha384",
  [OID.SHA512]: "sha512",
};

const SIGNATURE_DIGESTS: Readonly<Record<string, "sha256" | "sha384" | "sha512" | null>> = {
  [OID.SHA256_WITH_RSA]: "sha256",
  [OID.SHA384_WITH_RSA]: "sha384",
  [OID.SHA512_WITH_RSA]: "sha512",
  [OID.ECDSA_WITH_SHA256]: "sha256",
  [OID.ECDSA_WITH_SHA384]: "sha384",
  [OID.ECDSA_WITH_SHA512]: "sha512",
  [OID.ED25519]: null,
};

export class TimestampError extends Error {
  override readonly name = "TimestampError";
}

export interface TimestampRequest {
  readonly der: Buffer;
  readonly nonce: bigint;
}

/** TimeStampReq (version 1, SHA-256, nonce aléatoire 64 bits, certificats demandés). */
export function buildTimestampRequest(sha256Digest: Buffer, nonce = BigInt(`0x${randomBytes(8).toString("hex")}`)): TimestampRequest {
  if (sha256Digest.length !== 32) throw new TimestampError("empreinte SHA-256 de 32 octets attendue");
  const der = sequence(
    integer(1n),
    sequence(sequence(objectIdentifier(OID.SHA256), nullValue()), octetString(sha256Digest)),
    integer(nonce),
    booleanValue(true),
  );
  return { der, nonce };
}

export interface VerifiedTimestamp {
  /** Jeton (ContentInfo CMS) à conserver comme preuve. */
  readonly token: Buffer;
  readonly genTime: Date;
  readonly serialNumber: string;
  readonly policy: string;
  readonly signerSubject: string;
}

interface SignerInfo {
  readonly serialHex: string;
  readonly digestAlgorithm: "sha256" | "sha384" | "sha512";
  readonly signedAttributes: DerNode;
  readonly signatureAlgorithm: string;
  readonly signature: Buffer;
}

function find(nodes: readonly DerNode[], tag: number): DerNode | undefined {
  return nodes.find((node) => node.tag === tag);
}

function normalizeSerial(hex: string): string {
  return hex.replace(/^(00)+(?=.)/, "").toUpperCase();
}

function parseSignerInfo(node: DerNode): SignerInfo {
  const items = children(expectTag(node, TAG.SEQUENCE, "SignerInfo"));
  const [version, sid, digestAlgorithm, signedAttributes, signatureAlgorithm, signature] = items;
  if (decodeInteger(expectTag(version, TAG.INTEGER, "SignerInfo.version")) !== 1n) {
    throw new TimestampError("seuls les SignerInfo identifiés par émetteur et numéro de série sont acceptés");
  }
  const sidItems = children(expectTag(sid, TAG.SEQUENCE, "IssuerAndSerialNumber"));
  const serial = expectTag(sidItems[1], TAG.INTEGER, "numéro de série du signataire");
  const digestOid = decodeOid(expectTag(children(expectTag(digestAlgorithm, TAG.SEQUENCE, "digestAlgorithm"))[0], TAG.OID, "digestAlgorithm"));
  const digest = DIGESTS[digestOid];
  if (digest === undefined) throw new TimestampError(`algorithme de condensat non supporté : ${digestOid}`);
  return {
    serialHex: normalizeSerial(serial.content.toString("hex")),
    digestAlgorithm: digest,
    signedAttributes: expectTag(signedAttributes, TAG.CONTEXT_0, "signedAttrs"),
    signatureAlgorithm: decodeOid(expectTag(children(expectTag(signatureAlgorithm, TAG.SEQUENCE, "signatureAlgorithm"))[0], TAG.OID, "signatureAlgorithm")),
    signature: expectTag(signature, TAG.OCTET_STRING, "signature").content,
  };
}

function attributeValue(signedAttributes: DerNode, oid: string): DerNode | undefined {
  for (const attribute of children(signedAttributes)) {
    const [type, values] = children(expectTag(attribute, TAG.SEQUENCE, "Attribute"));
    if (type !== undefined && decodeOid(type) === oid) return children(expectTag(values, TAG.SET, "Attribute.values"))[0];
  }
  return undefined;
}

function verifySignerSignature(signer: SignerInfo, certificate: X509Certificate): void {
  // Les attributs signés sont signés sous leur encodage SET (0x31), pas [0].
  const data = Buffer.from(signer.signedAttributes.raw);
  data[0] = TAG.SET;
  let digest: "sha256" | "sha384" | "sha512" | null | undefined;
  if (signer.signatureAlgorithm === OID.RSA_ENCRYPTION) {
    digest = signer.digestAlgorithm;
  } else {
    digest = SIGNATURE_DIGESTS[signer.signatureAlgorithm];
    if (digest === undefined) throw new TimestampError(`algorithme de signature non supporté : ${signer.signatureAlgorithm}`);
  }
  if (!verifySignature(digest, data, certificate.publicKey, signer.signature)) {
    throw new TimestampError("signature de l'autorité d'horodatage invalide");
  }
}

function assertTrusted(signer: X509Certificate, trusted: readonly X509Certificate[], at: Date): void {
  if (at < new Date(signer.validFrom) || at > new Date(signer.validTo)) {
    throw new TimestampError("certificat de l'autorité d'horodatage hors validité à la date du jeton");
  }
  // Node renvoie undefined lorsque le certificat n'a pas d'extension EKU
  // (le type déclaré l'omet) : on le traite explicitement.
  const extendedUsages: unknown = signer.keyUsage;
  if (!Array.isArray(extendedUsages) || !extendedUsages.includes(OID.KP_TIME_STAMPING)) {
    throw new TimestampError("le certificat signataire n'est pas habilité à l'horodatage (EKU timeStamping)");
  }
  const pinned = trusted.some((certificate) => certificate.fingerprint256 === signer.fingerprint256);
  const issued = trusted.some((certificate) => signer.checkIssued(certificate) && signer.verify(certificate.publicKey));
  if (!pinned && !issued) throw new TimestampError("autorité d'horodatage non reconnue");
}

/**
 * Vérifie une TimeStampResp pour l'empreinte et le nonce demandés ; renvoie
 * le jeton vérifié. Lève TimestampError au moindre écart.
 */
export function verifyTimestampResponse(
  responseDer: Buffer,
  expected: { readonly sha256Digest: Buffer; readonly nonce: bigint },
  trustedCertificates: readonly X509Certificate[],
): VerifiedTimestamp {
  try {
    const response = children(expectTag(parseDer(responseDer), TAG.SEQUENCE, "TimeStampResp"));
    const statusInfo = children(expectTag(response[0], TAG.SEQUENCE, "PKIStatusInfo"));
    const status = decodeInteger(expectTag(statusInfo[0], TAG.INTEGER, "PKIStatus"));
    if (status !== 0n && status !== 1n) throw new TimestampError(`horodatage refusé par l'autorité (statut ${status})`);
    const token = expectTag(response[1], TAG.SEQUENCE, "TimeStampToken");

    const contentInfo = children(token);
    if (decodeOid(expectTag(contentInfo[0], TAG.OID, "contentType")) !== OID.SIGNED_DATA) {
      throw new TimestampError("le jeton n'est pas un SignedData CMS");
    }
    const signedData = children(expectTag(children(expectTag(contentInfo[1], TAG.CONTEXT_0, "content"))[0], TAG.SEQUENCE, "SignedData"));
    const encapsulated = children(expectTag(signedData[2], TAG.SEQUENCE, "encapContentInfo"));
    if (decodeOid(expectTag(encapsulated[0], TAG.OID, "eContentType")) !== OID.TST_INFO) {
      throw new TimestampError("le contenu signé n'est pas un TSTInfo");
    }
    const tstInfoDer = expectTag(children(expectTag(encapsulated[1], TAG.CONTEXT_0, "eContent"))[0], TAG.OCTET_STRING, "eContent").content;

    // --- TSTInfo : empreinte, nonce, date -----------------------------------
    const tstInfo = children(expectTag(parseDer(tstInfoDer), TAG.SEQUENCE, "TSTInfo"));
    const policy = decodeOid(expectTag(tstInfo[1], TAG.OID, "policy"));
    const imprint = children(expectTag(tstInfo[2], TAG.SEQUENCE, "messageImprint"));
    const imprintAlgorithm = decodeOid(expectTag(children(expectTag(imprint[0], TAG.SEQUENCE, "hashAlgorithm"))[0], TAG.OID, "hashAlgorithm"));
    const imprintValue = expectTag(imprint[1], TAG.OCTET_STRING, "hashedMessage").content;
    if (imprintAlgorithm !== OID.SHA256 || !imprintValue.equals(expected.sha256Digest)) {
      throw new TimestampError("le jeton porte une autre empreinte que celle demandée");
    }
    const serialNumber = decodeInteger(expectTag(tstInfo[3], TAG.INTEGER, "serialNumber")).toString(16).toUpperCase();
    const genTime = decodeGeneralizedTime(expectTag(tstInfo[4], TAG.GENERALIZED_TIME, "genTime"));
    const nonceNode = tstInfo.slice(5).find((node) => node.tag === TAG.INTEGER);
    if (nonceNode === undefined || decodeInteger(nonceNode) !== expected.nonce) {
      throw new TimestampError("nonce absent ou différent (réponse rejouée ?)");
    }

    // --- Signature CMS ----------------------------------------------------
    const certificateSet = find(signedData.slice(3), TAG.CONTEXT_0);
    if (certificateSet === undefined) throw new TimestampError("le jeton ne contient pas le certificat de l'autorité");
    const certificates = children(certificateSet).map((node) => new X509Certificate(node.raw));
    const signerInfos = children(expectTag(signedData.at(-1), TAG.SET, "signerInfos"));
    const [signerInfo] = signerInfos;
    if (signerInfos.length !== 1 || signerInfo === undefined) throw new TimestampError("un seul signataire attendu");
    const signer = parseSignerInfo(signerInfo);
    const signerCertificate = certificates.find((certificate) => normalizeSerial(certificate.serialNumber) === signer.serialHex);
    if (signerCertificate === undefined) throw new TimestampError("certificat du signataire introuvable dans le jeton");

    const contentType = attributeValue(signer.signedAttributes, OID.CONTENT_TYPE);
    if (contentType === undefined || decodeOid(contentType) !== OID.TST_INFO) throw new TimestampError("attribut contentType invalide");
    const messageDigest = attributeValue(signer.signedAttributes, OID.MESSAGE_DIGEST);
    const computed = createHash(signer.digestAlgorithm).update(tstInfoDer).digest();
    if (messageDigest === undefined || !expectTag(messageDigest, TAG.OCTET_STRING, "messageDigest").content.equals(computed)) {
      throw new TimestampError("condensat CMS différent du TSTInfo (jeton altéré)");
    }
    verifySignerSignature(signer, signerCertificate);
    assertTrusted(signerCertificate, trustedCertificates, genTime);

    return { token: Buffer.from(token.raw), genTime, serialNumber, policy, signerSubject: signerCertificate.subject };
  } catch (error: unknown) {
    if (error instanceof TimestampError) throw error;
    if (error instanceof DerError) throw new TimestampError(`réponse d'horodatage illisible : ${error.message}`, { cause: error });
    throw new TimestampError("réponse d'horodatage invalide", { cause: error });
  }
}

/** Client HTTP d'une autorité d'horodatage (RFC 3161 §3.4). */
export class TimestampAuthorityClient {
  constructor(
    private readonly url: string,
    private readonly trustedCertificates: readonly X509Certificate[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (trustedCertificates.length === 0) throw new TimestampError("au moins un certificat de confiance est requis");
  }

  async timestamp(sha256Digest: Buffer): Promise<VerifiedTimestamp> {
    const request = buildTimestampRequest(sha256Digest);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query", Accept: "application/timestamp-reply" },
      body: new Uint8Array(request.der),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new TimestampError(`autorité d'horodatage : HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return verifyTimestampResponse(body, { sha256Digest, nonce: request.nonce }, this.trustedCertificates);
  }
}

/** Charge un ou plusieurs certificats PEM (fichier de chaîne). */
export function parsePemBundle(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new TimestampError("aucun certificat PEM trouvé");
  return blocks.map((block) => new X509Certificate(block));
}
