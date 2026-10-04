import { z } from "./zod";

/** Schémas de formulaires partagés (mêmes bornes que l'API). */

export const justification = z.string().trim().min(10, "10 caractères au moins").max(1000);
export const note = z.string().trim().min(10, "10 caractères au moins").max(2000);
export const confirmed = z.literal("yes", "Confirmation requise");

/** Liste issue de cases à cocher (absente = vide, une seule = chaîne). */
export function checkboxList<T extends z.ZodType>(item: T): z.ZodType<z.output<T>[]> {
  return z.preprocess((value) => (value === undefined ? [] : typeof value === "string" ? [value] : value), z.array(item));
}

/** Plages d'adresses saisies une par ligne ou séparées par des virgules. */
export const ipRanges = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[\s,]+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : value,
  z
    .array(z.union([z.cidrv4(), z.cidrv6()], "plage CIDR attendue (ex. 203.0.113.0/24)"))
    .min(1, "au moins une plage")
    .max(10),
);
