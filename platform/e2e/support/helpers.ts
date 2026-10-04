import { createHmac, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import pg from "pg";

import { fieldContext, FieldEncryptor, KeyringKeyProvider } from "../../apps/api/src/lib/crypto/fieldEncryption.js";

import { e2eContext } from "./context.js";

/** Numéro mobile de France métropolitaine (06 12 …), unique par exécution ; 0696/0697 sont ultramarins. */
export function frenchMobileNumber(): string {
  return `+33612${randomInt(100_000, 999_999).toString()}`;
}

export function strongPassword(label: string): string {
  return `Phrase-${label}-${randomInt(1e9, 1e10 - 1).toString()}`;
}

// ---------------------------------------------------------------------------
// SMS : l'API de développement journalise le message (SMS_PROVIDER=log) avec
// un numéro masqué ; on attend un message NOUVEAU pour ce numéro.
// ---------------------------------------------------------------------------

interface SmsLine {
  readonly to: string;
  readonly body: string;
}

function smsLines(phone: string): readonly SmsLine[] {
  const masked = `${phone.slice(0, 4)}•••${phone.slice(-2)}`;
  const lines = readFileSync(e2eContext().apiLogFile, "utf8").split("\n");
  const result: SmsLine[] = [];
  for (const line of lines) {
    if (!line.includes("devSmsBody")) continue;
    const entry = JSON.parse(line) as { to?: unknown; devSmsBody?: unknown };
    if (entry.to === masked && typeof entry.devSmsBody === "string") result.push({ to: entry.to, body: entry.devSmsBody });
  }
  return result;
}

export function smsCount(phone: string): number {
  return smsLines(phone).length;
}

/** Code à 6 chiffres du premier SMS reçu par `phone` après les `seen` premiers. */
export async function waitForSmsCode(phone: string, seen: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const fresh = smsLines(phone).slice(seen);
    const code = fresh.length === 0 ? undefined : /\b(\d{6})\b/.exec(fresh[fresh.length - 1]?.body ?? "")?.[1];
    if (code !== undefined) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`aucun SMS reçu par ${phone.slice(0, 4)}•••${phone.slice(-2)}`);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 chiffres, 30 s). L'API refuse le rejeu d'un code :
// chaque appel attend au besoin la période suivante.
// ---------------------------------------------------------------------------

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("secret TOTP invalide");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 1_000_000).toString().padStart(6, "0");
}

const usedSteps = new Map<string, number>();

export async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    // Marge d'une seconde avant la fin de la période (transit jusqu'à l'API).
    const remaining = (step + 1) * 30_000 - now;
    if ((usedSteps.get(secret) ?? -1) < step && remaining > 1_500) {
      usedSteps.set(secret, step);
      return totpAt(secret, step);
    }
    await new Promise((resolve) => setTimeout(resolve, remaining + 50));
  }
}

// ---------------------------------------------------------------------------
// WebAuthn : authentificateurs virtuels de Chromium (protocole DevTools).
// ---------------------------------------------------------------------------

export interface VirtualAuthenticator {
  readonly cdp: CDPSession;
  readonly authenticatorId: string;
}

/**
 * - "security-key" : clé matérielle USB (CTAP2), non synchronisable — exigée pour le personnel ;
 * - "platform" : capteur intégré avec clé résidente (passkey du site client).
 */
export async function addVirtualAuthenticator(context: BrowserContext, page: Page, kind: "security-key" | "platform"): Promise<VirtualAuthenticator> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options:
      kind === "security-key"
        ? { protocol: "ctap2", transport: "usb", hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, defaultBackupEligibility: false, defaultBackupState: false }
        : { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

// ---------------------------------------------------------------------------
// Erreurs du navigateur : exceptions, erreurs de console (dont violations CSP).
// ---------------------------------------------------------------------------

export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`exception : ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const { url } = message.location();
      errors.push(`console : ${message.text()}${url === "" ? "" : ` (${url})`}`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Décision d'un prestataire KYC : seule simulation de la suite. Le prestataire
// (Onfido) est hors de la pile de test ; sa décision est enregistrée comme le
// ferait le service KYC, et le niveau est accordé par la base (trigger).
// ---------------------------------------------------------------------------

export async function withOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: e2eContext().ownerDatabaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Identifiant du seul client inscrit depuis `since` (exécution en série). */
export async function customerRegisteredSince(since: Date): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>("SELECT id FROM identity.users WHERE created_at >= $1 ORDER BY created_at", [since]);
    if (result.rows.length !== 1 || result.rows[0] === undefined) throw new Error(`un client attendu depuis ${since.toISOString()}, ${result.rows.length.toString()} trouvé(s)`);
    return result.rows[0].id;
  });
}

export interface DeclaredIdentity {
  readonly firstName: string;
  readonly lastName: string;
  /** AAAA-MM-JJ */
  readonly dateOfBirth: string;
}

/**
 * Vérification approuvée par le prestataire, telle que le service KYC
 * l'enregistre : identité déclarée par le client (chiffrée par le chiffreur
 * de champs de l'API, même contexte), puis décision et preuve d'identité.
 */
export async function approveKycAsProvider(userId: string, declared: DeclaredIdentity): Promise<void> {
  const { piiKeyId, piiKeyBase64 } = e2eContext();
  const encryptor = new FieldEncryptor(new KeyringKeyProvider(piiKeyId, new Map([[piiKeyId, Buffer.from(piiKeyBase64, "base64")]])));
  const field = (column: string): string => fieldContext("identity", "users", column, userId);
  const encrypted = [
    await encryptor.encrypt(declared.firstName, field("first_name")),
    await encryptor.encrypt(declared.lastName, field("last_name")),
    await encryptor.encrypt(declared.dateOfBirth, field("date_of_birth")),
  ];
  await withOwner(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.actor_type', 'customer', true), set_config('app.actor_id', $1, true)", [userId]);
      await client.query("UPDATE identity.users SET first_name_enc = $2, last_name_enc = $3, date_of_birth_enc = $4 WHERE id = $1", [userId, ...encrypted]);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  await withOwner(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.actor_type', 'provider', true), set_config('app.actor_id', 'onfido', true)");
      const verification = await client.query<{ id: string }>(
        `INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference)
         VALUES ($1, 'onfido', 'document_verification', 'tier_1', 'run-e2e-' || gen_random_uuid()) RETURNING id`,
        [userId],
      );
      const id = verification.rows[0]?.id;
      if (id === undefined) throw new Error("vérification non créée");
      await client.query("UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = $1", [id]);
      await client.query(
        "INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, pii_key_id, declared_identity_match) VALUES ($1, $2, 'onfido', $3, true)",
        [id, userId, e2eContext().piiKeyId],
      );
      await client.query("UPDATE kyc.verifications SET status = 'approved', decided_at = now(), expires_at = now() + interval '2 years' WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
