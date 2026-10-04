import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import { parseCsv, parseCsvRecords } from "../../../lib/csv.js";

/**
 * Listes de criblage.
 *
 *   - OFAC SDN (Trésor américain) : SDN.CSV (sans en-tête : ent_num, SDN_Name,
 *     SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag,
 *     Vess_owner, Remarks ; « -0- » = vide) et ALT.CSV (ent_num, alt_num,
 *     alt_type, alt_name, alt_remarks). Dates de naissance dans Remarks
 *     (« DOB 12 Jan 1960 »).
 *   - Liste consolidée du Conseil de sécurité de l'ONU (XML : INDIVIDUALS /
 *     ENTITIES, alias, dates de naissance, nationalités).
 *   - Personnes politiquement exposées OpenSanctions (targets.simple.csv,
 *     en-tête, valeurs multiples séparées par « ; »).
 */

export type ListKind = "sanctions" | "pep";
export type EntryType = "individual" | "entity" | "vessel" | "aircraft" | "unknown";

export interface ListEntry {
  readonly externalId: string;
  readonly entryType: EntryType;
  readonly primaryName: string;
  readonly aliases: readonly string[];
  readonly birthDates: readonly string[];
  readonly countries: readonly string[];
  readonly programs: readonly string[];
}

export interface FetchedList {
  readonly version: string;
  readonly contentSha256: Buffer;
  readonly entries: readonly ListEntry[];
}

export interface ListSource {
  readonly name: string;
  readonly kind: ListKind;
  fetchList(): Promise<FetchedList>;
}

export class ListSourceError extends Error {
  override readonly name = "ListSourceError";
}

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

async function download(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(300_000) });
  } catch (error: unknown) {
    throw new ListSourceError(`téléchargement impossible : ${url}`, { cause: error });
  }
  if (!response.ok) throw new ListSourceError(`HTTP ${response.status.toString()} : ${url}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new ListSourceError(`liste trop volumineuse : ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_DOWNLOAD_BYTES) throw new ListSourceError(`liste trop volumineuse : ${url}`);
  return body;
}

function sha256(...parts: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function clean(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "-0-" ? "" : trimmed;
}

// -----------------------------------------------------------------------------
// OFAC SDN
// -----------------------------------------------------------------------------

const OFAC_TYPES: Readonly<Record<string, EntryType>> = { individual: "individual", vessel: "vessel", aircraft: "aircraft", "": "entity" };

/** Analyse SDN.CSV + ALT.CSV. */
export function parseOfacSdn(sdnCsv: string, altCsv: string): ListEntry[] {
  const aliases = new Map<string, string[]>();
  for (const row of parseCsv(altCsv)) {
    const id = clean(row[0]);
    const name = clean(row[3]);
    if (id === "" || name === "") continue;
    aliases.set(id, [...(aliases.get(id) ?? []), name]);
  }
  const entries: ListEntry[] = [];
  for (const row of parseCsv(sdnCsv)) {
    const id = clean(row[0]);
    const name = clean(row[1]);
    if (!/^\d+$/.test(id) || name === "") continue;
    const remarks = clean(row[11]);
    const birthDates = [...remarks.matchAll(/DOB (?:circa )?((?:\d{1,2} [A-Za-z]{3} )?\d{4}(?: to (?:\d{1,2} [A-Za-z]{3} )?\d{4})?)/g)].map((match) => match[1] ?? "");
    const countries = [...remarks.matchAll(/(?:nationality|citizen) ([A-Z][A-Za-z ]+?)(?:;|\.|$)/g)].map((match) => (match[1] ?? "").trim());
    entries.push({
      externalId: id,
      entryType: OFAC_TYPES[clean(row[2]).toLowerCase()] ?? "unknown",
      primaryName: name,
      aliases: aliases.get(id) ?? [],
      birthDates: birthDates.filter((value) => value.length > 0),
      countries,
      programs: clean(row[3]).split(/\]\s*\[|[[\]]/).map((program) => program.trim()).filter((program) => program.length > 0),
    });
  }
  return entries;
}

export class OfacSdnSource implements ListSource {
  readonly name = "ofac_sdn";
  readonly kind = "sanctions" as const;

  constructor(
    private readonly urls: { readonly sdn: string; readonly alt: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchList(): Promise<FetchedList> {
    const [sdn, alt] = await Promise.all([download(this.fetchImpl, this.urls.sdn), download(this.fetchImpl, this.urls.alt)]);
    const entries = parseOfacSdn(sdn.toString("utf8"), alt.toString("utf8"));
    const contentSha256 = sha256(sdn, alt);
    return { version: `sha256:${contentSha256.toString("hex").slice(0, 16)}`, contentSha256, entries };
  }
}

// -----------------------------------------------------------------------------
// ONU
// -----------------------------------------------------------------------------

type XmlNode = Readonly<Record<string, unknown>>;

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && value !== null && "#text" in value) return xmlText((value as XmlNode)["#text"]);
  return "";
}

/** Analyse la liste consolidée de l'ONU (XML). */
export function parseUnConsolidated(xml: string): { readonly version: string; readonly entries: ListEntry[] } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true, processEntities: true });
  const document = parser.parse(xml) as XmlNode;
  const root = document["CONSOLIDATED_LIST"] as XmlNode | undefined;
  if (root === undefined) throw new ListSourceError("liste ONU : élément CONSOLIDATED_LIST absent");
  const version = xmlText(root["@dateGenerated"]) || "inconnue";
  const entries: ListEntry[] = [];

  const individuals = asArray((root["INDIVIDUALS"] as XmlNode | undefined)?.["INDIVIDUAL"]);
  for (const raw of individuals) {
    const node = raw as XmlNode;
    const id = xmlText(node["DATAID"]);
    const name = ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"].map((key) => xmlText(node[key])).filter((part) => part.length > 0).join(" ");
    if (id === "" || name === "") continue;
    const aliases = asArray(node["INDIVIDUAL_ALIAS"])
      .map((alias) => xmlText((alias as XmlNode)["ALIAS_NAME"]))
      .filter((alias) => alias.length > 0);
    const birthDates = asArray(node["INDIVIDUAL_DATE_OF_BIRTH"])
      .map((birth) => {
        const value = birth as XmlNode;
        return xmlText(value["DATE"]) || xmlText(value["YEAR"]) || [xmlText(value["FROM_YEAR"]), xmlText(value["TO_YEAR"])].filter((year) => year.length > 0).join(" to ");
      })
      .filter((date) => date.length > 0);
    const countries = asArray((node["NATIONALITY"] as XmlNode | undefined)?.["VALUE"]).map(xmlText).filter((country) => country.length > 0);
    entries.push({
      externalId: id,
      entryType: "individual",
      primaryName: name,
      aliases,
      birthDates,
      countries,
      programs: [xmlText(node["UN_LIST_TYPE"]), xmlText(node["REFERENCE_NUMBER"])].filter((value) => value.length > 0),
    });
  }

  const entities = asArray((root["ENTITIES"] as XmlNode | undefined)?.["ENTITY"]);
  for (const raw of entities) {
    const node = raw as XmlNode;
    const id = xmlText(node["DATAID"]);
    const name = xmlText(node["FIRST_NAME"]);
    if (id === "" || name === "") continue;
    entries.push({
      externalId: id,
      entryType: "entity",
      primaryName: name,
      aliases: asArray(node["ENTITY_ALIAS"]).map((alias) => xmlText((alias as XmlNode)["ALIAS_NAME"])).filter((alias) => alias.length > 0),
      birthDates: [],
      countries: [],
      programs: [xmlText(node["UN_LIST_TYPE"]), xmlText(node["REFERENCE_NUMBER"])].filter((value) => value.length > 0),
    });
  }
  return { version, entries };
}

export class UnConsolidatedSource implements ListSource {
  readonly name = "un_consolidated";
  readonly kind = "sanctions" as const;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchList(): Promise<FetchedList> {
    const body = await download(this.fetchImpl, this.url);
    const parsed = parseUnConsolidated(body.toString("utf8"));
    return { version: parsed.version, contentSha256: sha256(body), entries: parsed.entries };
  }
}

// -----------------------------------------------------------------------------
// OpenSanctions (PPE)
// -----------------------------------------------------------------------------

const OPENSANCTIONS_TYPES: Readonly<Record<string, EntryType>> = {
  Person: "individual",
  Organization: "entity",
  Company: "entity",
  LegalEntity: "entity",
  Vessel: "vessel",
  Airplane: "aircraft",
};

function multiValue(cell: string | undefined): string[] {
  if (cell === undefined || cell.trim() === "") return [];
  return (parseCsv(cell, ";")[0] ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Analyse targets.simple.csv (en-tête, valeurs multiples « ; »). */
export function parseOpenSanctionsSimple(csv: string): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const record of parseCsvRecords(csv)) {
    const id = (record["id"] ?? "").trim();
    const name = (record["name"] ?? "").trim();
    if (id === "" || name === "") continue;
    entries.push({
      externalId: id,
      entryType: OPENSANCTIONS_TYPES[(record["schema"] ?? "").trim()] ?? "unknown",
      primaryName: name,
      aliases: multiValue(record["aliases"]),
      birthDates: multiValue(record["birth_date"]),
      countries: multiValue(record["countries"]).map((country) => country.toUpperCase()),
      programs: multiValue(record["dataset"]),
    });
  }
  return entries;
}

export class OpenSanctionsPepSource implements ListSource {
  readonly name = "opensanctions_peps";
  readonly kind = "pep" as const;

  constructor(
    private readonly url: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchList(): Promise<FetchedList> {
    const body = await download(this.fetchImpl, this.url, this.apiKey === undefined ? {} : { Authorization: `ApiKey ${this.apiKey}` });
    const contentSha256 = sha256(body);
    return { version: `sha256:${contentSha256.toString("hex").slice(0, 16)}`, contentSha256, entries: parseOpenSanctionsSimple(body.toString("utf8")) };
  }
}
