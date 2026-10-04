import type { Page } from "@playwright/test";

import { e2eContext } from "../support/context.js";
import { expect, signIn, test } from "../support/staff.js";

/**
 * Paramétrage depuis le back-office : le binôme fondateur remplace le barème
 * de frais du corridor France → Sénégal. La demande n'a aucun effet tant
 * qu'un second membre ne l'a pas approuvée ; une fois exécutée, le prix
 * client l'applique immédiatement et l'ancien barème est clos.
 */
test.describe.configure({ mode: "serial" });

async function previewFee(page: Page): Promise<string> {
  // Valeurs par défaut du formulaire : France → Sénégal, 100 EUR, carte, mobile money.
  await page.goto(`${e2eContext().adminUrl}/parametrage/apercu?sourceCountry=FR&destinationCountry=SN&sourceCurrency=EUR&destinationCurrency=XOF&payoutMethod=mobile_money&fundingMethod=card&amount=100`);
  const result = page.getByRole("region", { name: "Résultat" });
  await expect(result).toBeVisible();
  return (await result.locator("div", { has: page.getByRole("term").filter({ hasText: /^Frais$/ }) }).getByRole("definition").textContent()) ?? "";
}

test("remplacement d'un barème de frais : demandé par l'une, approuvé par l'autre, appliqué au prix client", async ({ staff }) => {
  const [a, b] = e2eContext().founders;
  const requester = await staff.member(a.email);
  const approver = await staff.member(b.email);

  await signIn(requester, "/parametrage");
  const page = requester.page;
  await expect(page.getByRole("heading", { name: "Paramétrage", level: 1 })).toBeVisible();
  expect(await previewFee(page)).toMatch(/^1,99\s€$/);

  await page.goto(`${e2eContext().adminUrl}/parametrage/frais`);
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Nouveau barème" }) });
  await form.getByLabel("Devise d'envoi").fill("EUR");
  await form.getByLabel("Frais fixes").fill("1,49");
  await form.getByLabel("Frais proportionnels (%)").fill("0");
  await form.getByLabel("Minimum").fill("0");
  await form.getByLabel("Remplace le barème (même périmètre)").selectOption({ index: 1 });
  await form.getByLabel("Justification").fill("Baisse des frais du corridor Sénégal (recette de bout en bout)");
  await form.getByRole("button", { name: "Demander le nouveau barème" }).click();
  await expect(form.getByText("Demande créée : un second membre habilité doit l'approuver avant toute modification.")).toBeVisible();

  // Aucun effet avant l'approbation ; la demande est signalée sur le barème visé.
  expect(await previewFee(page)).toMatch(/^1,99\s€$/);
  await page.goto(`${e2eContext().adminUrl}/parametrage/frais`);
  await expect(page.getByRole("link", { name: "Demande en cours" })).toBeVisible();

  await signIn(approver, "/approbations");
  await approver.page.getByRole("link", { name: "Nouveau barème de frais" }).first().click();
  await expect(approver.page.getByRole("definition").filter({ hasText: /^1,49\s€\s\+\s0,00\s%$/ })).toBeVisible();
  await approver.page.getByLabel(/J'ai vérifié le contenu/).check();
  await approver.page.getByRole("button", { name: "Approuver et exécuter" }).click();
  await expect(approver.page.getByRole("definition").filter({ hasText: /^Exécutée$/ })).toBeVisible();

  expect(await previewFee(page)).toMatch(/^1,49\s€$/);
  await page.goto(`${e2eContext().adminUrl}/parametrage/frais?etat=tout`);
  await expect(page.getByRole("row").filter({ hasText: /1,99\s€/ }).getByText("Terminée")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: /1,49\s€/ }).getByText("En vigueur")).toBeVisible();
  expect([...requester.errors, ...approver.errors]).toEqual([]);
});

test("un pays interdit reste fermé, et une demande incohérente est refusée avant toute approbation", async ({ staff }) => {
  const requester = await staff.member(e2eContext().founders[0].email);
  await signIn(requester, "/parametrage/pays/SN");
  const page = requester.page;
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Modifier l'ouverture et le risque" }) });
  await form.getByLabel("Ouvert à la réception").selectOption("yes");
  await form.getByLabel("Niveau de risque").selectOption("prohibited");
  await form.getByLabel("Justification").fill("Demande volontairement incohérente");
  await form.getByRole("button", { name: "Demander la modification" }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: "Demande en cours" })).toHaveCount(0);
  expect(requester.errors).toEqual([]);
});
