import { importPKCS8, SignJWT } from "jose";

import type { GoogleServiceAccount } from "../../../config/env.js";
import { AttestationError, attestationClientDataHash } from "./types.js";
import type { AttestationInput, AttestationResult, AttestationVerifier } from "./types.js";

/**
 * Vérification d'un jeton Google Play Integrity (requête standard) par l'API
 * serveur decodeIntegrityToken, authentifiée par compte de service OAuth 2.0.
 *
 * Exigences :
 *   - requestHash = base64url(clientDataHash) (liaison défi + clé d'appareil) ;
 *   - paquet attendu, application reconnue par Google Play (PLAY_RECOGNIZED),
 *     certificat de signature autorisé ;
 *   - appareil MEETS_DEVICE_INTEGRITY (appareil Android authentique) ;
 *   - jeton émis il y a moins de 10 minutes.
 */

const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const MAX_TOKEN_AGE_MS = 10 * 60 * 1000;

interface DecodedPayload {
  readonly tokenPayloadExternal?: {
    readonly requestDetails?: { readonly requestPackageName?: string; readonly requestHash?: string; readonly timestampMillis?: string };
    readonly appIntegrity?: {
      readonly appRecognitionVerdict?: string;
      readonly packageName?: string;
      readonly certificateSha256Digest?: readonly string[];
    };
    readonly deviceIntegrity?: { readonly deviceRecognitionVerdict?: readonly string[] };
    readonly accountDetails?: { readonly appLicensingVerdict?: string };
  };
}

export interface PlayIntegrityOptions {
  readonly packageName: string;
  readonly certificateDigests: readonly string[];
  readonly serviceAccount: GoogleServiceAccount;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class PlayIntegrityVerifier implements AttestationVerifier {
  private cachedToken: { readonly value: string; readonly expiresAtMs: number } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PlayIntegrityOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async verify(input: AttestationInput): Promise<AttestationResult> {
    if (input.evidence.type !== "play_integrity") throw new AttestationError("preuve Play Integrity attendue");
    if (!/^[A-Za-z0-9._-]{100,8192}$/.test(input.evidence.integrityToken)) {
      throw new AttestationError("jeton Play Integrity mal formé");
    }
    const accessToken = await this.accessToken();
    const response = await this.fetchImpl(
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.options.packageName)}:decodeIntegrityToken`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ integrity_token: input.evidence.integrityToken }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new AttestationError(`décodage Play Integrity refusé (HTTP ${response.status})`);
    const payload = ((await response.json()) as DecodedPayload).tokenPayloadExternal;
    if (payload === undefined) throw new AttestationError("réponse Play Integrity vide");

    const expectedHash = attestationClientDataHash(input.challenge, input.devicePublicKeySpki).toString("base64url");
    const request = payload.requestDetails;
    if (request?.requestPackageName !== this.options.packageName) throw new AttestationError("paquet de la requête inattendu");
    if (request.requestHash !== expectedHash) throw new AttestationError("requestHash incorrect (défi ou clé d'appareil non liés)");
    const issuedAt = Number(request.timestampMillis);
    if (!Number.isFinite(issuedAt) || Math.abs(this.now() - issuedAt) > MAX_TOKEN_AGE_MS) {
      throw new AttestationError("jeton Play Integrity périmé");
    }

    const app = payload.appIntegrity;
    if (app?.appRecognitionVerdict !== "PLAY_RECOGNIZED") throw new AttestationError("application non reconnue par Google Play");
    if (app.packageName !== this.options.packageName) throw new AttestationError("paquet attesté inattendu");
    const digests = app.certificateSha256Digest ?? [];
    if (!digests.some((digest) => this.options.certificateDigests.includes(digest))) {
      throw new AttestationError("certificat de signature de l'application non autorisé");
    }
    const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    if (!deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")) throw new AttestationError("intégrité de l'appareil non établie");

    return {
      type: "play_integrity",
      details: {
        deviceVerdicts: [...deviceVerdicts],
        licensing: payload.accountDetails?.appLicensingVerdict ?? "UNEVALUATED",
      },
    };
  }

  /**
   * Contrôle d'exploitation : le compte de service obtient un jeton OAuth et
   * l'API Play Integrity accepte de décoder pour ce paquet. Un jeton
   * volontairement invalide est soumis : HTTP 400 signifie que l'appel est
   * autorisé (seul le jeton est refusé), 401/403 que le compte de service
   * n'est pas lié à l'application dans la Play Console ou que l'API n'est pas
   * activée sur son projet Google Cloud.
   */
  async checkAccess(): Promise<{ readonly authorized: boolean; readonly httpStatus: number }> {
    const accessToken = await this.accessToken();
    const response = await this.fetchImpl(
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.options.packageName)}:decodeIntegrityToken`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ integrity_token: "controle-d-exploitation" }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    await response.body?.cancel();
    return { authorized: response.status === 400, httpStatus: response.status };
  }

  /** Jeton OAuth 2.0 du compte de service (assertion JWT RS256), mis en cache. */
  private async accessToken(): Promise<string> {
    if (this.cachedToken !== undefined && this.cachedToken.expiresAtMs - 60_000 > this.now()) return this.cachedToken.value;
    const account = this.options.serviceAccount;
    const key = await importPKCS8(account.private_key, "RS256");
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(account.client_email)
      .setAudience(account.token_uri)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);
    const response = await this.fetchImpl(account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new AttestationError(`obtention du jeton OAuth Google refusée (HTTP ${response.status})`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new AttestationError("réponse OAuth Google inattendue");
    }
    this.cachedToken = { value: body.access_token, expiresAtMs: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
