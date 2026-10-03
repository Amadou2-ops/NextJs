import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Autorité d'horodatage RFC 3161 locale, adossée à `openssl ts -reply` :
 * une vraie implémentation indépendante produit les réponses que l'API doit
 * vérifier. Crée une racine de test et un certificat de TSA (EKU
 * timeStamping), ou volontairement sans EKU pour les tests négatifs.
 */
export class OpenSslTimestampAuthority {
  readonly directory: string;
  readonly rootCertificate: X509Certificate;
  private requests = 0;

  constructor(options: { readonly withTimeStampingUsage?: boolean } = {}) {
    this.directory = mkdtempSync(join(tmpdir(), "tsa-"));
    const run = (args: readonly string[]): void => {
      execFileSync("openssl", args, { cwd: this.directory, stdio: "pipe" });
    };
    run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "30",
      "-subj", "/CN=Test TSA Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "tsa.key", "-out", "tsa.csr", "-subj", "/CN=Test TSA Signer"]);
    writeFileSync(
      join(this.directory, "ext.cnf"),
      options.withTimeStampingUsage === false
        ? "keyUsage=critical,digitalSignature\n"
        : "extendedKeyUsage=critical,timeStamping\nkeyUsage=critical,digitalSignature\n",
    );
    run(["x509", "-req", "-in", "tsa.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "tsa.pem", "-days", "30", "-extfile", "ext.cnf"]);
    writeFileSync(
      join(this.directory, "tsa.cnf"),
      [
        "[ tsa ]",
        "default_tsa = tsa_config",
        "[ tsa_config ]",
        "serial = ./tsaserial",
        "crypto_device = builtin",
        "signer_digest = sha256",
        "default_policy = 1.2.3.4.1",
        "digests = sha256, sha384, sha512",
        "accuracy = secs:1",
        "ordering = no",
        "tsa_name = no",
        "ess_cert_id_chain = no",
        "ess_cert_id_alg = sha256",
        "",
      ].join("\n"),
    );
    writeFileSync(join(this.directory, "tsaserial"), "01\n");
    this.rootCertificate = new X509Certificate(readFileSync(join(this.directory, "ca.pem")));
  }

  get rootPem(): string {
    return readFileSync(join(this.directory, "ca.pem"), "utf8");
  }

  /** Répond à une TimeStampReq DER par une TimeStampResp DER signée. */
  reply(requestDer: Buffer): Buffer {
    this.requests += 1;
    const requestFile = `req-${this.requests}.tsq`;
    const responseFile = `resp-${this.requests}.tsr`;
    writeFileSync(join(this.directory, requestFile), requestDer);
    execFileSync(
      "openssl",
      ["ts", "-reply", "-config", "tsa.cnf", "-queryfile", requestFile, "-signer", "tsa.pem", "-inkey", "tsa.key", "-out", responseFile],
      { cwd: this.directory, stdio: "pipe" },
    );
    return readFileSync(join(this.directory, responseFile));
  }

  /** Implémentation de fetch pour TimestampAuthorityClient. */
  fetch(): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      const body = Buffer.from(init.body as Uint8Array);
      return Promise.resolve(new Response(new Uint8Array(this.reply(body)), { status: 200, headers: { "Content-Type": "application/timestamp-reply" } }));
    }) as unknown as typeof fetch;
  }

  /** Vérification indépendante d'un jeton par OpenSSL (comme le ferait un auditeur). */
  opensslVerify(token: Buffer, digestHex: string): string {
    writeFileSync(join(this.directory, "token.der"), token);
    return execFileSync(
      "openssl",
      ["ts", "-verify", "-in", "token.der", "-token_in", "-digest", digestHex, "-CAfile", "ca.pem", "-untrusted", "tsa.pem"],
      { cwd: this.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }
}
