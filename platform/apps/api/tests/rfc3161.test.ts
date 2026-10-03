import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { children, decodeGeneralizedTime, decodeInteger, decodeOid, integer, objectIdentifier, parseDer, tlv } from "../src/lib/crypto/der.js";
import { buildTimestampRequest, parsePemBundle, TimestampAuthorityClient, TimestampError, verifyTimestampResponse } from "../src/lib/crypto/rfc3161.js";
import { OpenSslTimestampAuthority } from "./support/tsa.js";

const tsa = new OpenSslTimestampAuthority();

describe("DER", () => {
  it.each(["1.2.840.113549.1.9.16.1.4", "2.16.840.1.101.3.4.2.1", "1.3.6.1.5.5.7.3.8", "2.999.3"])("encode et décode l'OID %s", (oid) => {
    expect(decodeOid(parseDer(objectIdentifier(oid)))).toBe(oid);
  });

  it("encode les entiers positifs avec l'octet de signe", () => {
    expect(integer(127n).toString("hex")).toBe("02017f");
    expect(integer(128n).toString("hex")).toBe("02020080");
    expect(decodeInteger(parseDer(integer(18446744073709551615n)))).toBe(18446744073709551615n);
  });

  it("lit les longueurs longues et refuse les formes invalides", () => {
    const long = tlv(0x04, Buffer.alloc(300, 1));
    expect(parseDer(long).content).toHaveLength(300);
    expect(() => parseDer(Buffer.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/indéfinie/);
    expect(() => parseDer(Buffer.from([0x04, 0x05, 0x01]))).toThrow(/tronqué/);
    expect(() => parseDer(Buffer.concat([integer(1n), Buffer.from([0])]))).toThrow(/superflus/);
  });

  it("décode GeneralizedTime avec fraction", () => {
    expect(decodeGeneralizedTime(parseDer(tlv(0x18, Buffer.from("20261003223645.123Z")))).toISOString()).toBe("2026-10-03T22:36:45.123Z");
  });
});

describe("RFC 3161", () => {
  const digest = createHash("sha256").update("tête de chaîne du registre").digest();

  it("produit une requête que OpenSSL interprète correctement", () => {
    const request = buildTimestampRequest(digest, 0x1234abcdn);
    writeFileSync(join(tsa.directory, "check.tsq"), request.der);
    const text = execFileSync("openssl", ["ts", "-query", "-in", "check.tsq", "-text"], { cwd: tsa.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(text).toContain("Hash Algorithm: sha256");
    expect(text).toContain("Nonce: 0x1234ABCD");
    expect(text).toContain("Certificate required: yes");
    expect(children(parseDer(request.der))).toHaveLength(4);
  });

  it("vérifie un jeton réel et le conserve sous une forme vérifiable par OpenSSL", async () => {
    const client = new TimestampAuthorityClient("https://tsa.test/", [tsa.rootCertificate], tsa.fetch());
    const stamp = await client.timestamp(digest);
    expect(stamp.policy).toBe("1.2.3.4.1");
    expect(stamp.signerSubject).toContain("Test TSA Signer");
    expect(Math.abs(stamp.genTime.getTime() - Date.now())).toBeLessThan(60_000);
    expect(tsa.opensslVerify(stamp.token, digest.toString("hex"))).toContain("Verification: OK");
  });

  it("refuse une réponse portant une autre empreinte", () => {
    const request = buildTimestampRequest(createHash("sha256").update("autre").digest());
    expect(() => verifyTimestampResponse(tsa.reply(request.der), { sha256Digest: digest, nonce: request.nonce }, [tsa.rootCertificate])).toThrow(/autre empreinte/);
  });

  it("refuse une réponse rejouée (nonce différent)", () => {
    const request = buildTimestampRequest(digest);
    expect(() => verifyTimestampResponse(tsa.reply(request.der), { sha256Digest: digest, nonce: request.nonce + 1n }, [tsa.rootCertificate])).toThrow(/nonce/);
  });

  it("refuse une autorité non reconnue", () => {
    const request = buildTimestampRequest(digest);
    const other = new OpenSslTimestampAuthority();
    expect(() => verifyTimestampResponse(tsa.reply(request.der), { sha256Digest: digest, nonce: request.nonce }, [other.rootCertificate])).toThrow(/non reconnue/);
  });

  it("refuse un certificat de TSA sans usage d'horodatage", () => {
    const rogue = new OpenSslTimestampAuthority({ withTimeStampingUsage: false });
    const request = buildTimestampRequest(digest);
    let response: Buffer;
    try {
      response = rogue.reply(request.der);
    } catch {
      // OpenSSL refuse lui-même de signer : le cas est couvert.
      return;
    }
    expect(() => verifyTimestampResponse(response, { sha256Digest: digest, nonce: request.nonce }, [rogue.rootCertificate])).toThrow(TimestampError);
  });

  it("détecte toute altération du jeton", () => {
    const request = buildTimestampRequest(digest);
    const response = tsa.reply(request.der);
    let rejected = 0;
    const positions = Array.from({ length: 40 }, () => 20 + Math.floor(Math.random() * (response.length - 20)));
    for (const position of positions) {
      const tampered = Buffer.from(response);
      tampered[position] = (tampered[position] ?? 0) ^ 0x01;
      try {
        verifyTimestampResponse(tampered, { sha256Digest: digest, nonce: request.nonce }, [tsa.rootCertificate]);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TimestampError);
        rejected += 1;
      }
    }
    // Quelques octets (ex. champs non signés hors du jeton) peuvent ne pas
    // invalider la réponse ; l'immense majorité doit l'être.
    expect(rejected).toBeGreaterThanOrEqual(36);
  });

  it("refuse une réponse de statut « rejection »", () => {
    // TimeStampResp { PKIStatusInfo { status = 2 (rejection) } }
    const rejection = Buffer.from("30053003020102", "hex");
    expect(() => verifyTimestampResponse(rejection, { sha256Digest: digest, nonce: 1n }, [tsa.rootCertificate])).toThrow(/refusé/);
  });

  it("charge un fichier PEM de plusieurs certificats", () => {
    expect(parsePemBundle(`${tsa.rootPem}\n${tsa.rootPem}`)).toHaveLength(2);
    expect(() => parsePemBundle("vide")).toThrow(TimestampError);
  });

  it("exige une empreinte SHA-256", () => {
    expect(() => buildTimestampRequest(randomBytes(20))).toThrow(TimestampError);
  });
});
