import { z } from "zod";

const country = z.string().regex(/^[A-Z]{2}$/, "code pays ISO 3166-1 alpha-2 attendu");
const currency = z.string().regex(/^[A-Z]{3}$/, "code devise ISO 4217 attendu");
const payoutMethod = z.enum(["bank_account", "mobile_money", "cash_pickup", "card", "wallet"]);
const fundingMethod = z.enum(["wallet_balance", "card", "bank_transfer", "mobile_money", "apple_pay", "google_pay"]);
const minorUnits = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/, "montant entier positif en unités mineures attendu")
  .transform((value) => BigInt(value));

const quoteFields = {
  destinationCountry: country,
  sourceCurrency: currency,
  destinationCurrency: currency,
  payoutMethod,
  fundingMethod: fundingMethod.default("card"),
  amount: minorUnits,
  amountType: z.enum(["send", "receive"]).default("send"),
};

/** Simulation publique : le pays d'envoi est fourni (visiteur non connecté). */
export const estimateQuerySchema = z.object({ sourceCountry: country, ...quoteFields }).strict();

/** Devis client : le pays d'envoi est le pays de résidence du client. */
export const createQuoteSchema = z.object(quoteFields).strict();

export const quoteIdParamsSchema = z.object({ quoteId: z.uuid() }).strict();
