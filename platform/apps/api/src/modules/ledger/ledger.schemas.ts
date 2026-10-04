import { z } from "zod";

const currency = z.string().regex(/^[A-Z]{3}$/, "code devise ISO 4217 attendu");
const cursor = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/, "curseur invalide")
  .transform((value) => BigInt(value));
const limit = z.coerce.number().int().min(1).max(100).default(25);

export const openWalletSchema = z.object({ currency }).strict();
export const walletCurrencyParamsSchema = z.object({ currency }).strict();
export const statementQuerySchema = z.object({ before: cursor.optional(), limit }).strict();

export const accountIdParamsSchema = z.object({ accountId: z.uuid() }).strict();
export const journalIdParamsSchema = z.object({ journalId: z.uuid() }).strict();
