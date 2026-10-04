import "server-only";

import { z } from "zod";

/**
 * Forme minimale d'une réponse WebAuthn du navigateur, contrôlée avant
 * transmission ; la vérification cryptographique (défi, origine, RP ID,
 * vérification de l'utilisateur, compteur) est faite par l'API.
 */
export const webauthnResponseSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),
  rawId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),
  type: z.literal("public-key"),
  response: z.looseObject({}),
});
