import { z } from "zod";

import { PURPOSE_CODES } from "./transfer.types.js";

export const createTransferSchema = z
  .object({
    quoteId: z.uuid(),
    recipientId: z.uuid(),
    purposeCode: z.enum(PURPOSE_CODES),
    // Session web : confirmation par code TOTP (la session mobile signe la requête avec l'appareil).
    totpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const listTransfersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  })
  .strict();

export const transferIdParamsSchema = z.object({ transferId: z.uuid() }).strict();
