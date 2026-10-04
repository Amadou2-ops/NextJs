import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseCsv, parseCsvRecords } from "../src/lib/csv.js";
import { ListIngestionService } from "../src/modules/aml/listIngestion.service.js";
import { parseOfacSdn, parseOpenSanctionsSimple, parseUnConsolidated } from "../src/modules/aml/lists/sources.js";
import { birthYears, jaroWinkler, nameMatchScore, normalizeForScreening, screeningTokens } from "../src/modules/aml/nameMatching.js";
import { silentLogger } from "./support/fixtures.js";
import { createPaymentHarness, staticListSource, TEST_SANCTIONS } from "./support/paymentHarness.js";

// =============================================================================
// Primitives
// =============================================================================

describe("rapprochement de noms", () => {
  it("calcule Jaro-Winkler conformément aux valeurs de référence", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("normalise accents, ordre des noms, particules et lettres non décomposables", () => {
    expect(screeningTokens("Abu Bakr al-Baghdadi")).toEqual(["baghdadi", "bakr"]);
    expect(normalizeForScreening("OUSMANE, Amadou Karim")).toBe("amadou karim ousmane");
    expect(normalizeForScreening("Søren Øster-Gaß")).toBe("gass oster soren");
    expect(normalizeForScreening("Aïssatou N'Diaye")).toBe("aissatou diaye n");
  });

  it("note fortement un homonyme, une variante orthographique ou un ordre différent", () => {
    expect(nameMatchScore("Amadou Karim Ousmane", "OUSMANE, Amadou Karim")).toBe(1);
    expect(nameMatchScore("Amadou Karim Ousmanne", "OUSMANE, Amadou Karim")).toBeGreaterThan(0.9);
    expect(nameMatchScore("Amadou Ousmane", "OUSMANE, Amadou Karim")).toBeGreaterThan(0.88);
    expect(nameMatchScore("Aminata Diop", "OUSMANE, Amadou Karim")).toBeLessThan(0.6);
    expect(nameMatchScore("A Ousmane", "OUSMANE, Amadou Karim")).toBeGreaterThan(nameMatchScore("B Ousmane", "OUSMANE, Amadou Karim"));
    expect([...birthYears(["12 Mar 1971", "circa 1968 to 1970", "inconnue"])]).toEqual([1971, 1968, 1970]);
  });

  it("lit le CSV RFC 4180 (guillemets, retours à la ligne, en-tête, BOM)", () => {
    expect(parseCsv('a,"b ""c""",d\r\n"multi\nligne",e\n')).toEqual([["a", 'b "c"', "d"], ["multi\nligne", "e"]]);
    expect(parseCsvRecords("﻿id,name\n1,Alpha\n")).toEqual([{ id: "1", name: "Alpha" }]);
    expect(() => parseCsv('"non fermé')).toThrow();
  });
});

describe("listes officielles", () => {
  it("analyse SDN.CSV et ALT.CSV de l'OFAC (alias, dates de naissance, programmes)", () => {
    const sdn = [
      '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Havana, Cuba."',
      '7543,"OUSMANE, Amadou Karim","individual","SDGT] [IRGC",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 12 Mar 1971; alt. DOB 1972; nationality Mali."',
      '9999,"LADY OF THE SEA","vessel","IRAN",-0- ,"9HAB2",-0- ,-0- ,-0- ,"Malta",-0- ,-0- ',
    ].join("\r\n");
    const alt = ['7543,101,"aka","OUSMANE, Amadou K.",-0- ', '7543,102,"fka","KARIM, Amadou",-0- '].join("\r\n");
    const entries = parseOfacSdn(sdn, alt);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ externalId: "36", entryType: "entity", programs: ["CUBA"] });
    expect(entries[1]).toEqual({
      externalId: "7543",
      entryType: "individual",
      primaryName: "OUSMANE, Amadou Karim",
      aliases: ["OUSMANE, Amadou K.", "KARIM, Amadou"],
      birthDates: ["12 Mar 1971", "1972"],
      countries: ["Mali"],
      programs: ["SDGT", "IRGC"],
    });
    expect(entries[2]?.entryType).toBe("vessel");
  });

  it("analyse la liste consolidée de l'ONU (individus, entités, alias, dates)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <CONSOLIDATED_LIST dateGenerated="2026-09-30T12:00:00.000Z">
        <INDIVIDUALS>
          <INDIVIDUAL>
            <DATAID>6908555</DATAID><FIRST_NAME>AMADOU</FIRST_NAME><SECOND_NAME>KARIM</SECOND_NAME><THIRD_NAME>OUSMANE</THIRD_NAME>
            <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDi.999</REFERENCE_NUMBER>
            <NATIONALITY><VALUE>Mali</VALUE></NATIONALITY>
            <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Abou Karim</ALIAS_NAME></INDIVIDUAL_ALIAS>
            <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>Karim l'Ancien</ALIAS_NAME></INDIVIDUAL_ALIAS>
            <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1971-03-12</DATE></INDIVIDUAL_DATE_OF_BIRTH>
            <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>APPROXIMATELY</TYPE_OF_DATE><YEAR>1970</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
          </INDIVIDUAL>
        </INDIVIDUALS>
        <ENTITIES>
          <ENTITY><DATAID>110</DATAID><FIRST_NAME>SAHEL TRADING &amp; CO</FIRST_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
            <ENTITY_ALIAS><ALIAS_NAME>STC</ALIAS_NAME></ENTITY_ALIAS></ENTITY>
        </ENTITIES>
      </CONSOLIDATED_LIST>`;
    const parsed = parseUnConsolidated(xml);
    expect(parsed.version).toBe("2026-09-30T12:00:00.000Z");
    expect(parsed.entries).toEqual([
      {
        externalId: "6908555",
        entryType: "individual",
        primaryName: "AMADOU KARIM OUSMANE",
        aliases: ["Abou Karim", "Karim l'Ancien"],
        birthDates: ["1971-03-12", "1970"],
        countries: ["Mali"],
        programs: ["Al-Qaida", "QDi.999"],
      },
      { externalId: "110", entryType: "entity", primaryName: "SAHEL TRADING & CO", aliases: ["STC"], birthDates: [], countries: [], programs: ["Al-Qaida"] },
    ]);
    expect(() => parseUnConsolidated("<AUTRE/>")).toThrow();
  });

  it("analyse targets.simple.csv d'OpenSanctions (valeurs multiples)", () => {
    const csv = 'id,schema,name,aliases,birth_date,countries,addresses,identifiers,sanctions,phones,emails,dataset,first_seen,last_seen,last_change\n' +
      'Q123,Person,Fatoumata Bintou CAMARA,"F. B. Camara;Fatou Camara",1965-05-20,gn;sn,,,,,,"Every Politician;Wikidata PEPs",2024-01-01,2026-09-01,2026-09-01\n';
    expect(parseOpenSanctionsSimple(csv)).toEqual([
      {
        externalId: "Q123",
        entryType: "individual",
        primaryName: "Fatoumata Bintou CAMARA",
        aliases: ["F. B. Camara", "Fatou Camara"],
        birthDates: ["1965-05-20"],
        countries: ["GN", "SN"],
        programs: ["Every Politician", "Wikidata PEPs"],
      },
    ]);
  });
});

// =============================================================================
// Évaluation des transferts
// =============================================================================

const harness = await createPaymentHarness();
const { owner, apiPool, verifiedCustomer, totp, addRecipient, quote, createTransfer, transferStatus } = harness;

beforeAll(harness.setup);
beforeEach(harness.resetEach);
afterAll(harness.teardown);

async function evaluation(transferId: string): Promise<{ outcome: string; rule_results: { rule: string; triggered: boolean }[] } | undefined> {
  const result = await owner.query<{ outcome: string; rule_results: { rule: string; triggered: boolean }[] }>(
    "SELECT outcome::text, rule_results FROM aml.transfer_evaluations WHERE transfer_id = $1",
    [transferId],
  );
  return result.rows[0];
}

async function alertsOf(transferId: string): Promise<string[]> {
  const result = await owner.query<{ rule_code: string }>("SELECT rule_code FROM aml.alerts WHERE transfer_id = $1 ORDER BY rule_code", [transferId]);
  return result.rows.map((row) => row.rule_code);
}

async function payoutCount(transferId: string): Promise<number> {
  const result = await owner.query("SELECT 1 FROM payments.attempts WHERE transfer_id = $1 AND direction = 'payout'", [transferId]);
  return result.rowCount ?? 0;
}

/** Transfert historique (hors triggers) pour les règles portant sur une fenêtre de temps. */
async function historicTransfer(userId: string, recipientId: string, usdEquivalent: bigint, daysAgo: number): Promise<void> {
  const quoted = await owner.query<{ id: string }>(
    `INSERT INTO fx.quotes (user_id, source_country, destination_country, source_currency, destination_currency, payout_method, funding_method,
                            source_amount, fee_amount, total_debit, destination_amount, mid_rate, customer_rate, margin_bps, usd_equivalent, expires_at)
     VALUES ($1, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 'wallet_balance', 10000, 199, 10199, fx.convert_minor(10000, 646.117645, 'EUR', 'XOF'),
             655.957, 646.117645, 150, $2, now() + interval '10 minutes')
     RETURNING id`,
    [userId, usdEquivalent.toString()],
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO transfers.transfers (user_id, recipient_id, quote_id, source_country, destination_country, source_currency, destination_currency,
                                        source_amount, fee_amount, total_debit, destination_amount, customer_rate, usd_equivalent, funding_method,
                                        payout_method, purpose_code, idempotency_key, authorization_method, authorized_at, status, created_at, completed_at)
       SELECT q.user_id, $2, q.id, 'FR', 'SN', 'EUR', 'XOF', 10000, 199, 10199, q.destination_amount, q.customer_rate, q.usd_equivalent,
              'wallet_balance', 'mobile_money', 'family_support', $3, 'totp', now(), 'completed', now() - make_interval(days => $4), now() - make_interval(days => $4)
         FROM fx.quotes q WHERE q.id = $1`,
      [quoted.rows[0]!.id, recipientId, `hist-${randomUUID()}`, daysAgo],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("évaluation AML des transferts", () => {
  it("laisse partir un transfert sans risque après avoir évalué chaque règle et criblé les deux parties", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221770001111");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    const transferId = response.body.transfer.id as string;
    expect(await transferStatus(transferId)).toBe("payout_processing");
    const result = await evaluation(transferId);
    expect(result?.outcome).toBe("clear");
    expect(result?.rule_results.map((rule) => rule.rule).sort()).toEqual([
      "HIGH_RISK_COUNTRY",
      "NEW_DEVICE_LARGE_TRANSFER",
      "PEP_MATCH",
      "RAPID_IN_OUT",
      "SANCTIONS_POTENTIAL_MATCH",
      "SCREENING_UNAVAILABLE",
      "SHARED_RECIPIENT",
      "SINGLE_LARGE_TRANSFER",
      "STRUCTURING",
      "VELOCITY_24H",
      "VELOCITY_COUNT_1H",
    ]);
    expect(result?.rule_results.filter((rule) => rule.triggered)).toEqual([]);
    const screenings = await owner.query<{ subject_type: string; status: string; list_versions: Record<string, string> }>(
      `SELECT s.subject_type::text, s.status::text, s.list_versions
         FROM aml.transfer_evaluations e JOIN aml.screenings s ON s.id IN (e.sender_screening_id, e.recipient_screening_id)
        WHERE e.transfer_id = $1 ORDER BY s.subject_type`,
      [transferId],
    );
    expect(screenings.rows.map((row) => [row.subject_type, row.status])).toEqual([["user", "clear"], ["recipient", "clear"]]);
    expect(Object.keys(screenings.rows[0]!.list_versions).sort()).toEqual(["test_peps", "test_sanctions"]);
    const profile = await owner.query<{ risk_level: string }>("SELECT risk_level::text FROM aml.customer_risk_profiles WHERE user_id = $1", [customer.userId]);
    expect(profile.rows[0]?.risk_level).toBe("low");
  });

  it("met en revue un bénéficiaire homonyme d'une personne sanctionnée, sans aucun paiement", async () => {
    const customer = await verifiedCustomer();
    const recipient = await request(harness.app)
      .post("/v1/recipients")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ country: "SN", currency: "XOF", firstName: "Amadou Karim", lastName: "Ousmane", account: { kind: "mobile_money", msisdn: "+221770002222", operator: "wave" } });
    expect(recipient.status).toBe(201);
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId: recipient.body.id as string, purposeCode: "gift", totpCode: totp(customer) });
    const transferId = response.body.transfer.id as string;
    expect(response.body.transfer).toMatchObject({ status: "compliance_review", statusReason: "aml_review" });
    expect(await alertsOf(transferId)).toEqual(["SANCTIONS_POTENTIAL_MATCH"]);
    expect(await payoutCount(transferId)).toBe(0);
    const alert = await owner.query<{ screening_id: string; severity: string }>("SELECT screening_id, severity::text FROM aml.alerts WHERE transfer_id = $1", [transferId]);
    expect(alert.rows[0]?.severity).toBe("critical");
    const screening = await owner.query<{ status: string; match_details: { matches: { external_id: string; score: number }[] } }>(
      "SELECT status::text, match_details FROM aml.screenings WHERE id = $1",
      [alert.rows[0]!.screening_id],
    );
    expect(screening.rows[0]?.status).toBe("potential_match");
    expect(screening.rows[0]?.match_details.matches[0]).toMatchObject({ external_id: TEST_SANCTIONS[0]!.externalId });
    const outbox = await owner.query<{ event_type: string }>("SELECT event_type FROM integrations.outbox WHERE aggregate_id = $1 AND event_type LIKE 'aml.%'", [transferId]);
    expect(outbox.rows.map((row) => row.event_type)).toEqual(["aml.transfer_review_required"]);

    // Le système ne peut pas lever l'alerte ni libérer le transfert.
    await expect(apiPool.query("UPDATE transfers.transfers SET status = 'payout_pending' WHERE id = $1", [transferId])).rejects.toThrow();
    const result = await harness.orchestrator.dispatchPayout(transferId);
    expect(result).toBe("ignored");
  });

  it("met en revue un expéditeur personne politiquement exposée", async () => {
    const customer = await verifiedCustomer({ identity: { firstName: "Fatoumata", lastName: "Camara", dateOfBirth: "1965-05-20" } });
    const recipientId = await addRecipient(customer, "+221770003333");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(response.body.transfer.status).toBe("compliance_review");
    expect(await alertsOf(response.body.transfer.id as string)).toEqual(["PEP_MATCH"]);
    const profile = await owner.query<{ factors: { pep_potential: boolean }; risk_score: number }>("SELECT factors, risk_score FROM aml.customer_risk_profiles WHERE user_id = $1", [customer.userId]);
    expect(profile.rows[0]?.factors.pep_potential).toBe(true);
    expect(profile.rows[0]?.risk_score).toBeGreaterThanOrEqual(45);
  });

  it("met en revue un transfert au seuil de déclaration", async () => {
    const customer = await verifiedCustomer({ tier: "tier_2", walletEur: 400_000n });
    const recipientId = await addRecipient(customer, "+221770004444");
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance", 276_000n, 300_000n), recipientId, purposeCode: "household_expenses", totpCode: totp(customer) });
    expect(response.status).toBe(201);
    expect(response.body.transfer.status).toBe("compliance_review");
    expect(await alertsOf(response.body.transfer.id as string)).toEqual(["SINGLE_LARGE_TRANSFER"]);
  });

  it("détecte le fractionnement sous le seuil et le bénéficiaire partagé", async () => {
    const structuring = await verifiedCustomer({ tier: "tier_2", walletEur: 400_000n });
    const recipientId = await addRecipient(structuring, "+221770005555");
    await historicTransfer(structuring.userId, recipientId, 285_000n, 2);
    await historicTransfer(structuring.userId, recipientId, 290_000n, 4);
    const response = await createTransfer(structuring, { quoteId: await quote(structuring, "wallet_balance", 260_000n, 282_000n), recipientId, purposeCode: "family_support", totpCode: totp(structuring) });
    expect(response.body.transfer.status).toBe("compliance_review");
    expect(await alertsOf(response.body.transfer.id as string)).toContain("STRUCTURING");

    // Six expéditeurs distincts vers les mêmes coordonnées en 30 jours.
    const shared = "+221770006666";
    for (let index = 0; index < 5; index += 1) {
      const sender = await verifiedCustomer();
      await historicTransfer(sender.userId, await addRecipient(sender, shared), 10_000n, 1);
    }
    const sixth = await verifiedCustomer();
    const transfer = await createTransfer(sixth, { quoteId: await quote(sixth, "wallet_balance"), recipientId: await addRecipient(sixth, shared), purposeCode: "family_support", totpCode: totp(sixth) });
    expect(transfer.body.transfer.status).toBe("compliance_review");
    expect(await alertsOf(transfer.body.transfer.id as string)).toEqual(["SHARED_RECIPIENT"]);
  });

  it("met en revue tout transfert lorsque les listes de sanctions sont périmées", async () => {
    const ageLists = async (interval: string): Promise<void> => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`UPDATE aml.list_versions SET imported_at = imported_at ${interval} WHERE is_current`);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await ageLists("- interval '72 hours'");
    try {
      const customer = await verifiedCustomer();
      const recipientId = await addRecipient(customer, "+221770007777");
      const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
      expect(response.body.transfer.status).toBe("compliance_review");
      expect(await alertsOf(response.body.transfer.id as string)).toEqual(["SCREENING_UNAVAILABLE"]);
    } finally {
      await ageLists("+ interval '72 hours'");
    }
  });

  it("refuse tout nouveau transfert d'un client gelé par la conformité", async () => {
    const customer = await verifiedCustomer();
    const recipientId = await addRecipient(customer, "+221770008888");
    await owner.query("INSERT INTO aml.customer_risk_profiles (user_id, risk_level, risk_score, is_sanctioned) VALUES ($1, 'unacceptable', 100, true)", [customer.userId]);
    const response = await createTransfer(customer, { quoteId: await quote(customer, "wallet_balance"), recipientId, purposeCode: "family_support", totpCode: totp(customer) });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("COMPLIANCE_BLOCKED");
  });
});

describe("import des listes", () => {
  it("versionne chaque import, ignore un contenu identique et refuse une liste tronquée", async () => {
    const ingestion = new ListIngestionService(apiPool, silentLogger);
    const entries = Array.from({ length: 20 }, (_, index) => ({
      externalId: `E${index.toString()}`,
      entryType: "individual" as const,
      primaryName: `Personne Fictive ${index.toString()}`,
      aliases: [],
      birthDates: [],
      countries: [],
      programs: [],
    }));
    const first = await ingestion.refresh(staticListSource("test_import", "sanctions", entries));
    expect(first).toMatchObject({ status: "updated", entryCount: 20 });
    expect((await ingestion.refresh(staticListSource("test_import", "sanctions", entries))).status).toBe("unchanged");

    await expect(ingestion.refresh(staticListSource("test_import", "sanctions", entries.slice(0, 5)))).rejects.toThrow(/import refusé/);
    const alert = await owner.query("SELECT 1 FROM integrations.outbox WHERE event_type = 'aml.list_rejected' AND payload->>'source' = 'test_import'");
    expect(alert.rowCount).toBe(1);

    const updated = await ingestion.refresh(staticListSource("test_import", "sanctions", [...entries, { ...entries[0]!, externalId: "E99", primaryName: "Nouvelle Entrée" }]));
    expect(updated).toMatchObject({ status: "updated", entryCount: 21 });
    const versions = await owner.query<{ is_current: boolean; entry_count: number }>("SELECT is_current, entry_count FROM aml.list_versions WHERE source = 'test_import' ORDER BY id");
    expect(versions.rows).toEqual([
      { is_current: false, entry_count: 20 },
      { is_current: true, entry_count: 21 },
    ]);
  });
});
