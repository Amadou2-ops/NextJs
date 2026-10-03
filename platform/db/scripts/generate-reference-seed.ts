/**
 * Génère db/seed/0001_currencies.sql et db/seed/0002_countries.sql à partir
 * de sources publiques versionnées (paquets npm figés par pnpm-lock.yaml) :
 *
 *   - currency-codes       ISO 4217 (code, numéro, nom, nombre de décimales)
 *   - i18n-iso-countries   ISO 3166-1 (alpha-2, alpha-3, numérique, noms en/fr)
 *   - countries-list       continent et indicatif de repli
 *   - libphonenumber-js    indicatif téléphonique international
 *   - country-to-currency  devise principale de chaque pays
 *
 * Les fichiers générés sont committés : la génération est reproductible et
 * relue en revue de code, la base n'est jamais alimentée depuis le réseau.
 *
 * Usage : pnpm --filter @transfertplus/db generate:reference
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { countries as countriesList } from "countries-list";
import countryToCurrencyModule from "country-to-currency";
import currencyCodes from "currency-codes";
import isoCountries from "i18n-iso-countries";
import { getCountries as getPhoneCountries, getCountryCallingCode } from "libphonenumber-js";
import type { CountryCode as PhoneCountryCode } from "libphonenumber-js";

const require = createRequire(import.meta.url);
isoCountries.registerLocale(require("i18n-iso-countries/langs/en.json") as isoCountries.LocaleData);
isoCountries.registerLocale(require("i18n-iso-countries/langs/fr.json") as isoCountries.LocaleData);

type Continent = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

interface CurrencyRow {
  code: string;
  numericCode: string;
  name: string;
  minorUnits: number;
}

interface CountryRow {
  alpha2: string;
  alpha3: string;
  numericCode: string;
  nameEn: string;
  nameFr: string;
  continent: Continent;
  callingCode: string;
  defaultCurrency: string | null;
}

/**
 * Codes ISO 4217 exclus : fonds, unités de compte, métaux précieux, codes de
 * test (ce ne sont pas des monnaies de paiement de détail), ainsi que ANG,
 * retiré en 2025 et dont le numéro 532 a été réattribué à XCG.
 */
const EXCLUDED_CURRENCIES: ReadonlySet<string> = new Set([
  "ANG", "BOV", "CHE", "CHW", "CLF", "COU", "MXV", "USN", "UYI", "UYW",
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU", "XTS", "XUA", "XXX",
]);

/**
 * Codes ISO 4217 récents absents de la version figée de currency-codes.
 * XCG : florin caribéen, remplace ANG à Curaçao et Sint Maarten (2025).
 */
const SUPPLEMENTARY_CURRENCIES: readonly CurrencyRow[] = [
  { code: "XCG", numericCode: "532", name: "Caribbean Guilder", minorUnits: 2 },
];

const CONTINENTS: ReadonlySet<string> = new Set(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);

function fail(message: string): never {
  throw new Error(`generate-reference-seed : ${message}`);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildCurrencies(): CurrencyRow[] {
  const rows = new Map<string, CurrencyRow>();
  for (const code of currencyCodes.codes()) {
    if (EXCLUDED_CURRENCIES.has(code)) continue;
    const record = currencyCodes.code(code);
    if (record === undefined) fail(`devise ${code} sans enregistrement`);
    const digits = record.digits;
    if (!Number.isInteger(digits) || digits < 0 || digits > 4) {
      fail(`devise ${code} : nombre de décimales invalide (${String(digits)})`);
    }
    if (!/^[0-9]{3}$/.test(record.number)) fail(`devise ${code} : numéro ISO invalide (${record.number})`);
    rows.set(code, { code, numericCode: record.number, name: record.currency, minorUnits: digits });
  }
  for (const extra of SUPPLEMENTARY_CURRENCIES) {
    if (!rows.has(extra.code)) rows.set(extra.code, extra);
  }
  return [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function buildCountries(currencies: ReadonlyMap<string, CurrencyRow>): CountryRow[] {
  const phoneCountries: ReadonlySet<string> = new Set(getPhoneCountries());
  const countryToCurrency = countryToCurrencyModule as unknown as Readonly<Record<string, string | undefined>>;
  const rows: CountryRow[] = [];

  for (const alpha2 of Object.keys(isoCountries.getAlpha2Codes()).sort()) {
    const alpha3 = isoCountries.alpha2ToAlpha3(alpha2) ?? fail(`${alpha2} sans alpha-3`);
    const numericCode = isoCountries.alpha2ToNumeric(alpha2) ?? fail(`${alpha2} sans code numérique`);
    const nameEn = isoCountries.getName(alpha2, "en") ?? fail(`${alpha2} sans nom anglais`);
    const nameFr = isoCountries.getName(alpha2, "fr") ?? fail(`${alpha2} sans nom français`);

    const listEntry = (countriesList as Readonly<Record<string, { continent: string; phone: readonly number[] } | undefined>>)[alpha2];
    if (listEntry === undefined) fail(`${alpha2} absent de countries-list`);
    if (!CONTINENTS.has(listEntry.continent)) fail(`${alpha2} : continent inconnu ${listEntry.continent}`);

    let callingCode: string;
    if (phoneCountries.has(alpha2)) {
      callingCode = getCountryCallingCode(alpha2 as PhoneCountryCode);
    } else {
      const fallback = listEntry.phone[0];
      if (fallback === undefined) fail(`${alpha2} sans indicatif téléphonique`);
      callingCode = String(fallback);
    }
    if (!/^[0-9]{1,4}$/.test(callingCode)) fail(`${alpha2} : indicatif invalide ${callingCode}`);

    const currency = countryToCurrency[alpha2];
    const defaultCurrency = currency !== undefined && currencies.has(currency) ? currency : null;

    rows.push({
      alpha2,
      alpha3,
      numericCode: numericCode.padStart(3, "0"),
      nameEn,
      nameFr,
      continent: listEntry.continent as Continent,
      callingCode,
      defaultCurrency,
    });
  }

  const numericSeen = new Set<string>();
  for (const row of rows) {
    if (numericSeen.has(row.numericCode)) fail(`code numérique dupliqué ${row.numericCode} (${row.alpha2})`);
    numericSeen.add(row.numericCode);
  }
  return rows;
}

function renderCurrencies(rows: readonly CurrencyRow[]): string {
  const values = rows
    .map((r) => `    (${sqlString(r.code)}, ${sqlString(r.numericCode)}, ${sqlString(r.name)}, ${r.minorUnits})`)
    .join(",\n");
  return `-- =============================================================================
-- Devises ISO 4217 — FICHIER GÉNÉRÉ par db/scripts/generate-reference-seed.ts.
-- Ne pas modifier à la main. ${rows.length} devises.
-- Toutes les devises sont fermées (is_enabled = false) ; leur ouverture est
-- une décision commerciale et de conformité.
-- La relance est sans effet sur is_enabled et ne touche jamais minor_units
-- (figé par trigger).
-- =============================================================================
INSERT INTO ref.currencies (code, numeric_code, name, minor_units) VALUES
${values}
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
WHERE ref.currencies.name IS DISTINCT FROM EXCLUDED.name;
`;
}

function renderCountries(rows: readonly CountryRow[]): string {
  const values = rows
    .map(
      (r) =>
        `    (${sqlString(r.alpha2)}, ${sqlString(r.alpha3)}, ${sqlString(r.numericCode)}, ${sqlString(r.nameEn)}, ` +
        `${sqlString(r.nameFr)}, ${sqlString(r.continent)}, ${sqlString(r.callingCode)}, ` +
        `${r.defaultCurrency === null ? "NULL" : sqlString(r.defaultCurrency)})`,
    )
    .join(",\n");
  return `-- =============================================================================
-- Pays ISO 3166-1 — FICHIER GÉNÉRÉ par db/scripts/generate-reference-seed.ts.
-- Ne pas modifier à la main. ${rows.length} pays et territoires.
-- Aucun pays n'est ouvert (can_send / can_receive = false). La relance ne
-- modifie jamais risk_level, can_send ni can_receive.
-- =============================================================================
INSERT INTO ref.countries (alpha2, alpha3, numeric_code, name_en, name_fr, continent, calling_code, default_currency) VALUES
${values}
ON CONFLICT (alpha2) DO UPDATE SET
    name_en = EXCLUDED.name_en,
    name_fr = EXCLUDED.name_fr,
    calling_code = EXCLUDED.calling_code,
    default_currency = EXCLUDED.default_currency
WHERE (ref.countries.name_en, ref.countries.name_fr, ref.countries.calling_code, ref.countries.default_currency)
      IS DISTINCT FROM (EXCLUDED.name_en, EXCLUDED.name_fr, EXCLUDED.calling_code, EXCLUDED.default_currency);
`;
}

function main(): void {
  const seedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "seed");
  const currencies = buildCurrencies();
  const currencyMap = new Map(currencies.map((c) => [c.code, c] as const));
  const countries = buildCountries(currencyMap);

  writeFileSync(join(seedDir, "0001_currencies.sql"), renderCurrencies(currencies), "utf8");
  writeFileSync(join(seedDir, "0002_countries.sql"), renderCountries(countries), "utf8");

  const withoutCurrency = countries.filter((c) => c.defaultCurrency === null).map((c) => c.alpha2);
  process.stdout.write(
    `${currencies.length} devises, ${countries.length} pays générés.` +
      (withoutCurrency.length > 0 ? ` Pays sans devise par défaut : ${withoutCurrency.join(", ")}.` : "") +
      "\n",
  );
}

main();
