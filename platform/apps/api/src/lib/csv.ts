/**
 * Lecteur CSV conforme RFC 4180 : champs entre guillemets, guillemets
 * doublés, retours à la ligne dans un champ, fins de ligne CRLF ou LF.
 * Lève une erreur sur un guillemet non fermé (fichier tronqué).
 */
export function parseCsv(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === separator) {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error("CSV invalide : guillemet non fermé");
  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV avec ligne d'en-tête → enregistrements indexés par nom de colonne. */
export function parseCsvRecords(text: string, separator = ","): Record<string, string>[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const [header, ...rows] = parseCsv(withoutBom, separator);
  if (header === undefined) return [];
  return rows.map((row) => Object.fromEntries(header.map((name, index) => [name.trim(), row[index] ?? ""])));
}
