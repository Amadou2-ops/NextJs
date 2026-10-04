"use server";

import { CORRIDORS, MOBILE_OPERATORS } from "@/lib/format";
import { trustedPaymentUrl } from "@/lib/payment";
import type { CreatedTransfer, Quote, Recipient } from "@/lib/types";
import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { actionApi } from "@/server/context";

/**
 * Parcours d'envoi. Chaque étape est validée ici puis par l'API, qui fait
 * foi (devis, plafonds KYC, conformité, autorisation renforcée).
 */

const corridorCountries = CORRIDORS.map((item) => item.country) as [string, ...string[]];

const quoteSchema = z.strictObject({
  destinationCountry: z.enum(corridorCountries),
  destinationCurrency: z.string().regex(/^[A-Z]{3}$/),
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  payoutMethod: z.enum(["mobile_money", "bank_account", "cash_pickup"]),
  fundingMethod: z.enum(["card", "bank_transfer", "wallet_balance"]),
  amount: z.string().regex(/^[1-9][0-9]{0,14}$/, "Montant invalide"),
  amountType: z.enum(["send", "receive"]),
});

export async function quoteAction(input: z.input<typeof quoteSchema>): Promise<ActionState<Quote>> {
  const parsed = quoteSchema.safeParse(input);
  if (!parsed.success) return failure("Informations de devis invalides.");
  const corridor = CORRIDORS.find((item) => item.country === parsed.data.destinationCountry);
  if (corridor?.currency !== parsed.data.destinationCurrency) return failure("Devise de réception incohérente avec le pays choisi.");
  try {
    return { status: "success", data: await actionApi<Quote>({ method: "POST", path: "/v1/quotes", body: parsed.data }) };
  } catch (error: unknown) {
    return fromError(error);
  }
}

const operators = MOBILE_OPERATORS.map(([code]) => code) as [string, ...string[]];

const recipientSchema = z
  .strictObject({
    country: z.enum(corridorCountries),
    currency: z.string().regex(/^[A-Z]{3}$/),
    firstName: z.string().trim().min(1, "Prénom requis").max(100),
    lastName: z.string().trim().min(1, "Nom requis").max(100),
    relationship: z.enum(["family", "friend", "self", "business", "other"]),
    kind: z.enum(["mobile_money", "bank_account", "cash_pickup"]),
    msisdn: z.string().trim().max(32).optional(),
    operator: z.enum(operators).optional(),
    iban: z.string().trim().max(42).optional(),
    accountNumber: z.string().trim().max(40).optional(),
    bankCode: z.string().trim().max(20).optional(),
  })
  .superRefine((value, context) => {
    if ((value.kind === "mobile_money" || value.kind === "cash_pickup") && (value.msisdn === undefined || value.msisdn.length < 6)) {
      context.addIssue({ code: "custom", path: ["msisdn"], message: "Numéro de téléphone requis" });
    }
    if (value.kind === "mobile_money" && value.operator === undefined) context.addIssue({ code: "custom", path: ["operator"], message: "Opérateur requis" });
    if (value.kind === "bank_account" && (value.iban === undefined || value.iban.length === 0) && (value.accountNumber === undefined || value.accountNumber.length === 0)) {
      context.addIssue({ code: "custom", path: ["iban"], message: "IBAN ou numéro de compte requis" });
    }
  });

function accountOf(value: z.output<typeof recipientSchema>): Record<string, string> {
  switch (value.kind) {
    case "mobile_money":
      return { kind: "mobile_money", msisdn: value.msisdn ?? "", operator: value.operator ?? "" };
    case "cash_pickup":
      return { kind: "cash_pickup", msisdn: value.msisdn ?? "" };
    case "bank_account":
      return value.iban !== undefined && value.iban.length > 0
        ? { kind: "bank_account", iban: value.iban }
        : { kind: "bank_account", accountNumber: value.accountNumber ?? "", ...(value.bankCode === undefined || value.bankCode.length === 0 ? {} : { bankCode: value.bankCode }) };
  }
}

export async function createRecipientAction(_previous: ActionState<Recipient>, form: FormData): Promise<ActionState<Recipient>> {
  const parsed = parseForm(recipientSchema, form);
  if (!parsed.ok) return parsed.state;
  try {
    const recipient = await actionApi<Recipient>({
      method: "POST",
      path: "/v1/recipients",
      body: {
        country: parsed.data.country,
        currency: parsed.data.currency,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        relationship: parsed.data.relationship,
        account: accountOf(parsed.data),
      },
    });
    return { status: "success", data: recipient };
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
}

const transferSchema = z.strictObject({
  quoteId: z.uuid(),
  recipientId: z.uuid(),
  purposeCode: z.enum(["family_support", "education", "medical_treatment", "gift", "household_expenses", "savings", "travel", "other"]),
  totpCode: z.string().regex(/^\d{6}$/, "Code à 6 chiffres"),
  // Clé d'idempotence générée par le formulaire : une double soumission rejoue le même transfert.
  idempotencyKey: z.string().regex(/^web-[0-9a-f-]{36}$/),
});

export interface TransferOutcome {
  readonly transferId: string;
  readonly next: { readonly kind: "detail" } | { readonly kind: "card" } | { readonly kind: "redirect"; readonly url: string };
}

export async function createTransferAction(input: z.input<typeof transferSchema>): Promise<ActionState<TransferOutcome>> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".")] ??= issue.message;
    return failure("Informations de transfert invalides.", fields);
  }
  const { idempotencyKey, ...body } = parsed.data;
  try {
    const created = await actionApi<CreatedTransfer>({ method: "POST", path: "/v1/transfers", body, idempotencyKey });
    const funding = created.funding;
    if (funding === null) return { status: "success", data: { transferId: created.transfer.id, next: { kind: "detail" } } };
    if (funding.type === "stripe_payment_intent") return { status: "success", data: { transferId: created.transfer.id, next: { kind: "card" } } };
    const url = trustedPaymentUrl(funding.url);
    if (url === null) return failure("Lien de paiement inattendu : contactez le service client.");
    return { status: "success", data: { transferId: created.transfer.id, next: { kind: "redirect", url } } };
  } catch (error: unknown) {
    return fromError(error);
  }
}
