import type { FieldSpec } from "@/components/ActionForm";
import type { PayinMethod, PayoutCorridor } from "@/lib/configuration";
import { minorToInput } from "@/lib/configuration";

/** Champs partagés des formulaires de corridor et de moyen d'encaissement (pré-remplis en modification). */

const YES_NO = [
  { value: "yes", label: "Oui" },
  { value: "no", label: "Non" },
];

function percentInput(bps: number): string {
  return (bps / 100).toString().replace(".", ",");
}

export function routingFields(current: PayoutCorridor | PayinMethod | null, currency: string | null): FieldSpec[] {
  const unit = currency === null ? "dans la devise" : `en ${currency}`;
  return [
    { name: "priority", label: "Priorité", kind: "text", maxLength: 6, defaultValue: current?.priority.toString() ?? "100", help: "La route active la moins coûteuse est choisie ; à coût égal, la plus prioritaire." },
    { name: "minAmount", label: `Montant minimum (${unit})`, kind: "text", maxLength: 20, ...(current !== null && currency !== null ? { defaultValue: minorToInput(current.minAmount, currency) } : {}) },
    { name: "maxAmount", label: `Montant maximum (${unit})`, kind: "text", maxLength: 20, ...(current !== null && currency !== null ? { defaultValue: minorToInput(current.maxAmount, currency) } : {}) },
    { name: "costFixed", label: `Coût fixe du prestataire (${unit})`, kind: "text", maxLength: 20, defaultValue: current !== null && currency !== null ? minorToInput(current.costFixed, currency) : "0" },
    { name: "cost", label: "Coût proportionnel du prestataire (%)", kind: "text", maxLength: 5, defaultValue: current === null ? "0" : percentInput(current.costBps) },
  ];
}

export function enabledField(current: { readonly isEnabled: boolean } | null): FieldSpec {
  return { name: "isEnabled", label: "Ouvert aux clients", kind: "select", options: YES_NO, defaultValue: current?.isEnabled === true ? "yes" : "no" };
}

export function yesNoField(name: string, label: string, value: boolean): FieldSpec {
  return { name, label, kind: "select", options: YES_NO, defaultValue: value ? "yes" : "no" };
}

export const JUSTIFICATION: FieldSpec = { name: "justification", label: "Justification", kind: "textarea", minLength: 10, maxLength: 1000 };
