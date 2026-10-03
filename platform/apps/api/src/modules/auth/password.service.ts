import { createHash } from "node:crypto";

import { hash, verify } from "@node-rs/argon2";

import { ValidationError } from "../../lib/errors.js";

/**
 * Mots de passe : Argon2id (RFC 9106), paramètres au-dessus du minimum OWASP
 * (m = 64 Mio, t = 3, p = 1). Le hachage s'exécute hors de la boucle
 * d'événements (thread natif).
 *
 * Politique : 10 à 128 caractères, pas de mot de passe trivial, pas de
 * mot de passe dérivé du numéro de téléphone, et refus des mots de passe
 * présents dans des fuites publiques (Have I Been Pwned, modèle k-anonymat :
 * seuls les 5 premiers caractères de l'empreinte SHA-1 quittent le serveur).
 */

// Algorithm.Argon2id vaut 2 (enum const non importable avec verbatimModuleSyntax).
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type BreachChecker = (password: string) => Promise<boolean>;

export class PasswordService {
  /** Empreinte factice, vérifiée lorsque le compte n'existe pas (temps constant). */
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly breachChecker: BreachChecker | undefined) {}

  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    if (!passwordHash.startsWith("$argon2id$")) return false;
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Consomme le même temps qu'une vérification réelle : un attaquant ne peut
   * pas distinguer « compte inexistant » de « mauvais mot de passe ».
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash("transfertplus-dummy-password-for-timing");
    await this.verify(await this.dummyHash, password);
    return false;
  }

  /** Vrai si l'empreinte a été produite avec des paramètres plus faibles. */
  needsRehash(passwordHash: string): boolean {
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
    if (match === null) return true;
    const [, memory, time, parallelism] = match;
    return (
      Number(memory) < ARGON2_OPTIONS.memoryCost ||
      Number(time) < ARGON2_OPTIONS.timeCost ||
      Number(parallelism) !== ARGON2_OPTIONS.parallelism
    );
  }

  async assertAcceptable(password: string, context: { readonly phoneE164?: string }): Promise<void> {
    const issues: string[] = [];
    // Nombre de points de code Unicode (un emoji composé compte plusieurs fois,
    // ce qui ne fait qu'allonger le mot de passe pris en compte).
    const length = Array.from(password).length;
    if (length < PASSWORD_MIN_LENGTH) issues.push(`au moins ${PASSWORD_MIN_LENGTH} caractères`);
    if (length > PASSWORD_MAX_LENGTH) issues.push(`au plus ${PASSWORD_MAX_LENGTH} caractères`);
    if (new Set(password).size < 4) issues.push("trop peu de caractères différents");
    if (/^(.)\1+$/.test(password) || /^(0123456789|1234567890|azertyuiop|qwertyuiop)/i.test(password)) {
      issues.push("suite de caractères trop prévisible");
    }
    if (context.phoneE164 !== undefined) {
      const digits = context.phoneE164.replace(/\D/g, "");
      const national = digits.slice(-8);
      if (national.length === 8 && password.replace(/\D/g, "").includes(national)) {
        issues.push("ne doit pas contenir votre numéro de téléphone");
      }
    }
    if (issues.length === 0 && this.breachChecker !== undefined && (await this.breachChecker(password))) {
      issues.push("ce mot de passe figure dans une fuite de données publique, choisissez-en un autre");
    }
    if (issues.length > 0) {
      throw new ValidationError(
        issues.map((message) => ({ path: "body.password", message })),
        "Le mot de passe ne respecte pas la politique de sécurité.",
      );
    }
  }
}

/**
 * Vérificateur Have I Been Pwned (API « range », sans clé, remplissage activé
 * pour masquer la taille des réponses). En cas d'indisponibilité, le contrôle
 * est ignoré (fail-open) : il complète la politique, il ne la remplace pas.
 */
export function createPwnedPasswordsChecker(
  fetchImpl: typeof fetch = fetch,
  onError: (error: unknown) => void = () => undefined,
): BreachChecker {
  return async (password: string): Promise<boolean> => {
    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    try {
      const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "TransfertPlus-API" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        onError(new Error(`HIBP a répondu ${response.status}`));
        return false;
      }
      const body = await response.text();
      for (const line of body.split("\n")) {
        const [candidate, count] = line.trim().split(":");
        if (candidate === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (error: unknown) {
      onError(error);
      return false;
    }
  };
}
