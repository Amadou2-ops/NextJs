import { checkboxList, justification } from "./forms";
import { currencyDigits, decimalToMinor } from "./format";
import { z } from "./zod";

/**
 * Ajustement comptable saisi ligne par ligne (montants décimaux), converti
 * en unités mineures selon la devise (aucun flottant). L'équilibre débits =
 * crédits par devise est vérifié ici pour un retour immédiat, puis par l'API
 * et par la base au moment de l'exécution.
 */

export const adjustmentFormSchema = z.strictObject({
  description: z.string().trim().min(10, "10 caractères au moins").max(500),
  justification,
  accountId: checkboxList(z.uuid("identifiant de compte invalide")),
  direction: checkboxList(z.enum(["debit", "credit"])),
  amount: checkboxList(z.string().trim().min(1, "montant requis").max(30)),
  currency: checkboxList(z.string().regex(/^[A-Z]{3}$/, "devise ISO 4217")),
});
export type AdjustmentForm = z.infer<typeof adjustmentFormSchema>;

export interface AdjustmentEntry {
  readonly accountId: string;
  readonly direction: "debit" | "credit";
  readonly amountMinor: string;
  readonly currency: string;
}

export function adjustmentEntries(input: Pick<AdjustmentForm, "accountId" | "direction" | "amount" | "currency">): { readonly entries: readonly AdjustmentEntry[] } | { readonly error: string } {
  const count = input.accountId.length;
  if (count < 2 || count > 20) return { error: "Un ajustement comporte entre 2 et 20 lignes." };
  if (input.direction.length !== count || input.amount.length !== count || input.currency.length !== count) return { error: "Lignes incomplètes." };
  const entries: AdjustmentEntry[] = [];
  const balance = new Map<string, bigint>();
  for (let index = 0; index < count; index += 1) {
    const line = (index + 1).toString();
    const currency = input.currency[index] ?? "";
    const direction = input.direction[index] ?? "debit";
    let digits: number;
    try {
      digits = currencyDigits(currency);
    } catch {
      return { error: `Ligne ${line} : devise inconnue.` };
    }
    const amountMinor = decimalToMinor(input.amount[index] ?? "", digits);
    if (amountMinor === null) return { error: `Ligne ${line} : montant invalide pour ${currency} (${digits.toString()} décimale(s) au plus, strictement positif).` };
    entries.push({ accountId: input.accountId[index] ?? "", direction, amountMinor, currency });
    balance.set(currency, (balance.get(currency) ?? 0n) + (direction === "debit" ? BigInt(amountMinor) : -BigInt(amountMinor)));
  }
  for (const [currency, net] of balance) {
    if (net !== 0n) return { error: `L'ajustement n'est pas équilibré en ${currency} : débits et crédits doivent être égaux.` };
  }
  return { entries };
}
