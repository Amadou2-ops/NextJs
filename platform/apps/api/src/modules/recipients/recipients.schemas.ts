import { z } from "zod";

const personName = z
  .string()
  .transform((value) => value.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().regex(/^\p{L}[\p{L}\p{M} '’.-]{0,99}$/u, "nom invalide (lettres, espaces, tirets, apostrophes)"));

export const MOBILE_OPERATORS = [
  "orange_money",
  "wave",
  "mtn_momo",
  "moov_money",
  "free_money",
  "mpesa",
  "airtel_money",
  "vodafone_cash",
] as const;

const phone = z.string().min(6).max(20);

const accountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mobile_money"), msisdn: phone, operator: z.enum(MOBILE_OPERATORS) }).strict(),
  z
    .object({
      kind: z.literal("bank_account"),
      iban: z.string().min(15).max(42).optional(),
      accountNumber: z.string().regex(/^[0-9A-Za-z -]{4,34}$/).optional(),
      bankCode: z.string().regex(/^[0-9A-Za-z]{2,15}$/).optional(),
    })
    .strict()
    .refine((value) => (value.iban !== undefined) !== (value.accountNumber !== undefined && value.bankCode !== undefined), {
      message: "IBAN, ou numéro de compte et code banque (exclusivement)",
    }),
  z.object({ kind: z.literal("cash_pickup"), msisdn: phone }).strict(),
]);

export const createRecipientSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    firstName: personName,
    lastName: personName,
    relationship: z.enum(["family", "friend", "self", "business", "other"]).optional(),
    account: accountSchema,
  })
  .strict();

export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;

export const recipientIdParamsSchema = z.object({ recipientId: z.uuid() }).strict();
