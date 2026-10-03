import { createHash } from "node:crypto";

/**
 * Attestation d'appareil : prouve que la clé publique de l'appareil a été
 * générée par l'application authentique, non modifiée, sur un appareil réel.
 *
 * Liaison cryptographique commune aux deux plateformes :
 *   clientData     = défi serveur (32 o) ‖ SHA-256(clé publique SPKI de l'appareil)
 *   clientDataHash = SHA-256(clientData)
 * iOS transmet clientDataHash à DCAppAttestService.attestKey ; Android le
 * transmet (base64url) comme requestHash à l'API Play Integrity.
 */

export type AttestationEvidence =
  | {
      readonly type: "app_attest";
      /** Identifiant de clé App Attest (base64). */
      readonly keyId: string;
      /** Objet d'attestation CBOR (base64). */
      readonly attestationObject: string;
    }
  | {
      readonly type: "play_integrity";
      /** Jeton d'intégrité chiffré renvoyé par l'API Play Integrity. */
      readonly integrityToken: string;
    };

export interface AttestationInput {
  readonly challenge: Buffer;
  readonly devicePublicKeySpki: Buffer;
  readonly evidence: AttestationEvidence;
}

export interface AttestationResult {
  readonly type: "app_attest" | "play_integrity";
  /** Détails non sensibles conservés pour l'investigation (environnement, verdicts). */
  readonly details: Readonly<Record<string, string | readonly string[]>>;
}

export interface AttestationVerifier {
  verify(input: AttestationInput): Promise<AttestationResult>;
}

export class AttestationError extends Error {
  override readonly name = "AttestationError";
}

export function attestationClientDataHash(challenge: Buffer, devicePublicKeySpki: Buffer): Buffer {
  const keyDigest = createHash("sha256").update(devicePublicKeySpki).digest();
  return createHash("sha256").update(Buffer.concat([challenge, keyDigest])).digest();
}

/** Aiguille vers le vérificateur de la plateforme ; refuse une plateforme non configurée. */
export class CompositeAttestationVerifier implements AttestationVerifier {
  constructor(
    private readonly appAttest: AttestationVerifier | undefined,
    private readonly playIntegrity: AttestationVerifier | undefined,
  ) {}

  verify(input: AttestationInput): Promise<AttestationResult> {
    const verifier = input.evidence.type === "app_attest" ? this.appAttest : this.playIntegrity;
    if (verifier === undefined) {
      return Promise.reject(new AttestationError(`attestation ${input.evidence.type} non configurée sur ce serveur`));
    }
    return verifier.verify(input);
  }
}
