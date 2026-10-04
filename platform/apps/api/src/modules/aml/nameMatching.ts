/**
 * Rapprochement de noms pour le criblage sanctions / PPE.
 *
 *   - normalisation : décomposition Unicode, suppression des diacritiques,
 *     translittération des lettres sans décomposition (ø, ß, æ…), minuscules,
 *     séparateurs unifiés, particules sans valeur discriminante retirées,
 *     jetons triés (l'ordre prénom / nom varie selon les listes) ;
 *   - notation : chaque jeton de la personne criblée est apparié au meilleur
 *     jeton candidat (Jaro-Winkler) ; la note combine la moyenne des
 *     appariements et la couverture du nom candidat, afin qu'un nom court
 *     inclus dans un nom long ne produise pas une fausse correspondance
 *     parfaite, et qu'une faute de frappe ne fasse pas disparaître un vrai
 *     homonyme.
 */

const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
};

/** Particules et titres qui n'identifient pas une personne. */
const IGNORED_TOKENS: ReadonlySet<string> = new Set(["al", "el", "bin", "ben", "ibn", "abu", "de", "da", "del", "der", "van", "von", "mr", "mrs", "dr", "sheikh", "haji"]);

export function screeningTokens(value: string): readonly string[] {
  const decomposed = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[øßæœđðþłı]/g, (char) => TRANSLITERATIONS[char] ?? char);
  const tokens = decomposed.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  const meaningful = tokens.filter((token) => !IGNORED_TOKENS.has(token));
  return (meaningful.length > 0 ? meaningful : tokens).sort();
}

export function normalizeForScreening(value: string): string {
  return screeningTokens(value).join(" ");
}

/** Similarité de Jaro-Winkler (préfixe commun ≤ 4, facteur 0,1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] === true || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (aMatched[i] !== true) continue;
    while (bMatched[k] !== true) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Note de correspondance [0, 1] entre le nom criblé et un nom de liste.
 * 85 % : qualité moyenne de l'appariement des jetons criblés ;
 * 15 % : part des jetons du nom de liste effectivement appariés.
 */
export function nameMatchScore(subject: string, candidate: string): number {
  const subjectTokens = screeningTokens(subject);
  const candidateTokens = screeningTokens(candidate);
  if (subjectTokens.length === 0 || candidateTokens.length === 0) return 0;
  const used = new Set<number>();
  let total = 0;
  for (const token of subjectTokens) {
    let best = 0;
    let bestIndex = -1;
    candidateTokens.forEach((other, index) => {
      if (used.has(index)) return;
      const score = jaroWinkler(token, other);
      if (score > best) {
        best = score;
        bestIndex = index;
      }
    });
    // Un jeton réduit à une initiale ne vaut que s'il coïncide avec l'initiale d'un jeton.
    if (token.length === 1 && bestIndex >= 0 && candidateTokens[bestIndex]?.[0] !== token) best = 0;
    if (bestIndex >= 0 && best >= 0.8) used.add(bestIndex);
    total += best;
  }
  const quality = total / subjectTokens.length;
  const coverage = used.size / candidateTokens.length;
  return Math.round((quality * 0.85 + coverage * 0.15) * 10_000) / 10_000;
}

/** Années de naissance citées dans une liste (« 1971 », « 1971-03-02 », « circa 1971 »). */
export function birthYears(dates: readonly string[]): ReadonlySet<number> {
  const years = new Set<number>();
  for (const date of dates) {
    for (const match of date.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) years.add(Number(match[1]));
  }
  return years;
}
