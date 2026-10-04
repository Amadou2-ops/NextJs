import { z } from "zod";

import { parseIsoDate } from "./providers/types.js";

/** Lettres (toutes écritures), espaces, tirets, apostrophes, points. */
const personName = z
  .string()
  .transform((value) => value.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().regex(/^\p{L}[\p{L}\p{M} '’.-]{0,99}$/u, "nom invalide (lettres, espaces, tirets, apostrophes)"));

const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date au format AAAA-MM-JJ attendue")
  .refine((value) => parseIsoDate(value) !== null, "date inexistante")
  .refine((value) => value >= "1900-01-01", "date de naissance invraisemblable");

export const startVerificationSchema = z
  .object({
    tier: z.enum(["tier_1", "tier_2"]),
    declaredIdentity: z
      .object({
        firstName: personName,
        lastName: personName,
        dateOfBirth,
      })
      .strict()
      .optional(),
  })
  .strict();

export const verificationIdParamsSchema = z.object({ verificationId: z.uuid() }).strict();
