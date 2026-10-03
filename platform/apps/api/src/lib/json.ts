/**
 * JSON et montants : aucun montant ne transite par un nombre flottant.
 *
 * - Lecture : le texte exact de chaque nombre est conservé (JSON.parse avec
 *   contexte source, Node ≥ 21) ; « 101.99 » reste la chaîne "101.99".
 * - Écriture : un montant décimal est émis comme littéral numérique JSON à
 *   partir de son texte exact (DecimalLiteral), jamais via Number.
 */

export function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? context.source : value,
  ) as unknown;
}

const DECIMAL_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export class DecimalLiteral {
  constructor(readonly text: string) {
    if (!DECIMAL_LITERAL.test(text)) throw new Error(`littéral décimal invalide : ${text}`);
  }
}

/** JSON.stringify où chaque DecimalLiteral devient un nombre JSON au texte exact. */
export function stringifyWithDecimals(value: unknown): string {
  const literals: string[] = [];
  const json = JSON.stringify(value, (_key: string, item: unknown) => {
    if (item instanceof DecimalLiteral) {
      literals.push(item.text);
      return `\u0000decimal:${(literals.length - 1).toString()}\u0000`;
    }
    return item;
  });
  return json.replace(/"\\u0000decimal:(\d+)\\u0000"/g, (_match, index: string) => {
    const literal = literals[Number(index)];
    if (literal === undefined) throw new Error("littéral décimal introuvable");
    return literal;
  });
}
