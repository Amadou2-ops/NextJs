import type { Queryable } from "../../db/transaction.js";
import { birthYears, nameMatchScore, normalizeForScreening } from "./nameMatching.js";

/**
 * Criblage d'une personne (expéditeur ou bénéficiaire) contre les versions
 * courantes des listes. Les candidats sont présélectionnés en base par
 * similarité de trigrammes puis notés finement (Jaro-Winkler par jeton),
 * avec ajustement sur l'année de naissance lorsqu'elle est connue des deux
 * côtés. Chaque criblage est conservé avec l'état exact des listes
 * consultées (versions), même lorsqu'il ne trouve rien.
 */

export interface ScreeningMatch {
  readonly source: string;
  readonly kind: "sanctions" | "pep";
  readonly externalId: string;
  readonly primaryName: string;
  readonly matchedName: string;
  readonly score: number;
  readonly programs: readonly string[];
}

export interface ScreeningResult {
  readonly id: string;
  readonly status: "clear" | "potential_match" | "error";
  readonly sanctionsMatches: readonly ScreeningMatch[];
  readonly pepMatches: readonly ScreeningMatch[];
  /** Listes de sanctions présentes et à jour au moment du criblage. */
  readonly listsAvailable: boolean;
}

export interface ScreeningOptions {
  readonly matchThreshold: number;
  readonly maxListAgeHours: number;
}

interface CandidateRow {
  entry_id: string;
  name: string;
  similarity: number;
  source: string;
  kind: "sanctions" | "pep";
  entry_type: string;
  primary_name: string;
  birth_dates: string[];
  programs: string[];
  external_id: string;
}

export class ScreeningService {
  constructor(private readonly options: ScreeningOptions) {}

  async screen(
    db: Queryable,
    subject: { readonly type: "user" | "recipient"; readonly id: string; readonly fullName: string; readonly birthDate: string | null },
  ): Promise<ScreeningResult> {
    const lists = await db.query<{ source: string; kind: "sanctions" | "pep"; version: string; fresh: boolean }>(
      `SELECT source, kind::text AS kind, version, imported_at > now() - make_interval(hours => $1) AS fresh
         FROM aml.list_versions WHERE is_current`,
      [this.options.maxListAgeHours],
    );
    const listsAvailable = lists.rows.some((row) => row.kind === "sanctions" && row.fresh);
    const normalized = normalizeForScreening(subject.fullName);

    const candidates =
      normalized.length === 0
        ? []
        : (
            await db.query<CandidateRow>(
              `SELECT entry_id::text, name, similarity, source, kind::text AS kind, entry_type::text, primary_name, birth_dates, programs, external_id
                 FROM aml.candidate_names($1, 0.3, 200)`,
              [normalized],
            )
          ).rows;

    const subjectYear = subject.birthDate === null ? null : Number(subject.birthDate.slice(0, 4));
    const best = new Map<string, ScreeningMatch>();
    for (const candidate of candidates) {
      // Une personne n'est rapprochée que d'individus (ou d'entrées de type inconnu).
      if (candidate.entry_type !== "individual" && candidate.entry_type !== "unknown") continue;
      let score = nameMatchScore(subject.fullName, candidate.name);
      const years = birthYears(candidate.birth_dates);
      if (subjectYear !== null && years.size > 0) score += years.has(subjectYear) ? 0.03 : -0.12;
      score = Math.max(0, Math.min(1, Math.round(score * 10_000) / 10_000));
      const key = `${candidate.source}:${candidate.external_id}`;
      const previous = best.get(key);
      if (previous === undefined || score > previous.score) {
        best.set(key, {
          source: candidate.source,
          kind: candidate.kind,
          externalId: candidate.external_id,
          primaryName: candidate.primary_name,
          matchedName: candidate.name,
          score,
          programs: candidate.programs.slice(0, 5),
        });
      }
    }
    const matches = [...best.values()].filter((match) => match.score >= this.options.matchThreshold).sort((a, b) => b.score - a.score);
    const sanctionsMatches = matches.filter((match) => match.kind === "sanctions");
    const pepMatches = matches.filter((match) => match.kind === "pep");
    const status: ScreeningResult["status"] = matches.length > 0 ? "potential_match" : listsAvailable ? "clear" : "error";

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO aml.screenings (subject_type, subject_id, provider, status, list_versions, match_details)
       VALUES ($1::aml.screening_subject, $2, 'internal_lists', $3::aml.screening_status, $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        subject.type,
        subject.id,
        status,
        JSON.stringify(Object.fromEntries(lists.rows.map((row) => [row.source, row.version]))),
        JSON.stringify({
          normalized_query: normalized,
          threshold: this.options.matchThreshold,
          lists_available: listsAvailable,
          matches: matches.slice(0, 10).map((match) => ({
            source: match.source,
            kind: match.kind,
            external_id: match.externalId,
            primary_name: match.primaryName,
            matched_name: match.matchedName,
            score: match.score,
            programs: match.programs,
          })),
        }),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error("enregistrement du criblage impossible");
    return { id, status, sanctionsMatches, pepMatches, listsAvailable };
  }
}
