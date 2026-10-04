import type { BrowserContext, Page } from "@playwright/test";

import { e2eContext } from "../support/context.js";
import { enableTotp, equityAccount, openWalletAsMobileApp, registerCustomer } from "../support/customer.js";
import { approveKycAsProvider, collectBrowserErrors, customerRegisteredSince, freshTotp, frenchMobileNumber, strongPassword, withOwner } from "../support/helpers.js";
import { expect, signIn, test } from "../support/staff.js";

/**
 * Transfert de bout en bout, à travers les deux applications :
 *   1. un client vérifié (décision KYC du prestataire) ouvre un portefeuille EUR ;
 *   2. le back-office le crédite par un ajustement comptable validé à deux ;
 *   3. le client envoie 100 EUR vers le Sénégal (mobile money), payés par son
 *      portefeuille et confirmés par son code TOTP ;
 *   4. aucune route de paiement sortant n'étant configurée dans la pile de
 *      test, l'API rembourse le transfert (comportement de production) ;
 *   5. le worker notifie le remboursement au client par SMS (outbox) ;
 *   6. le registre reste équilibré et sa chaîne de hachage intacte.
 */
test.describe.configure({ mode: "serial" });

const phone = frenchMobileNumber();
const password = strongPassword("expediteur");
let totpSecret = "";
let walletAccountId = "";
let customerContext: BrowserContext;
let customer: Page;
let errors: string[];
let transferUrl = "";

test.beforeAll(async ({ browser }) => {
  customerContext = await browser.newContext();
  customer = await customerContext.newPage();
  errors = collectBrowserErrors(customer);
});

test.afterAll(async () => {
  await customerContext.close();
});

async function walletCard(): Promise<ReturnType<Page["locator"]>> {
  await customer.goto(`${e2eContext().webUrl}/tableau-de-bord`);
  return customer.locator("section", { has: customer.getByRole("heading", { name: "Portefeuille EUR" }) });
}

test("client vérifié : identité approuvée par le prestataire, portefeuille EUR ouvert", async () => {
  const since = new Date();
  await registerCustomer(customer, phone, password);
  totpSecret = await enableTotp(customer);
  const userId = await customerRegisteredSince(since);
  await approveKycAsProvider(userId, { firstName: "Mariama", lastName: "Ndiaye", dateOfBirth: "1988-04-12" });
  walletAccountId = await openWalletAsMobileApp(userId, "EUR");

  const wallet = await walletCard();
  await expect(wallet.getByText("0,00 €", { exact: true })).toBeVisible();
  await expect(customer.getByText("Vérifiez votre identité pour envoyer")).toHaveCount(0);
});

test("crédit de 250 EUR par ajustement comptable : demandé par l'une, exécuté par l'autre", async ({ staff }) => {
  const [a, b] = e2eContext().founders;
  const equity = await equityAccount("EUR");
  const requester = await staff.member(a.email);
  const approver = await staff.member(b.email);

  await signIn(requester, "/registre/ajustement");
  const form = requester.page;
  await expect(form.getByRole("heading", { name: "Demande d'ajustement comptable" })).toBeVisible();
  await form.getByLabel("Libellé de l'écriture").fill("Dotation de lancement du portefeuille client");
  await form.getByLabel("Compte, ligne 1").fill(equity);
  await form.getByLabel("Sens, ligne 1").selectOption("debit");
  await form.getByLabel("Montant, ligne 1").fill("250");
  await form.getByLabel("Devise, ligne 1").selectOption("EUR");
  await form.getByLabel("Compte, ligne 2").fill(walletAccountId);
  await form.getByLabel("Sens, ligne 2").selectOption("credit");
  await form.getByLabel("Montant, ligne 2").fill("250");
  await form.getByLabel("Devise, ligne 2").selectOption("EUR");
  await form.getByLabel("Justification").fill("Recette de bout en bout : crédit validé par deux membres.");
  await form.getByRole("button", { name: "Créer la demande d'ajustement" }).click();
  await expect(form.getByText("Demande d'ajustement créée : un second membre doit l'approuver avant toute écriture.")).toBeVisible();

  // Rien n'est écrit avant l'approbation.
  await expect((await walletCard()).getByText("0,00 €", { exact: true })).toBeVisible();

  await signIn(approver, "/approbations");
  await approver.page.getByRole("link", { name: "Ajustement comptable" }).first().click();
  await approver.page.getByLabel(/J'ai vérifié le contenu/).check();
  await approver.page.getByRole("button", { name: "Approuver et exécuter" }).click();
  // Une fois exécutée, la demande n'a plus de formulaire : son état fait foi.
  await expect(approver.page.getByRole("definition").filter({ hasText: /^Exécutée$/ })).toBeVisible();
  expect([...requester.errors, ...approver.errors]).toEqual([]);

  await expect((await walletCard()).getByText("250,00 €", { exact: true })).toBeVisible();
});

/** Étape 1 du parcours d'envoi : devis garanti, payé par le portefeuille EUR. */
async function requestQuote(amount: string): Promise<void> {
  await customer.goto(`${e2eContext().webUrl}/envoyer`);
  await customer.getByLabel("Pays du bénéficiaire").selectOption("SN");
  await customer.getByLabel("Mode de réception").selectOption("mobile_money");
  await customer.getByLabel("Je paie par").selectOption("wallet_balance");
  await customer.getByLabel("Devise d'envoi").selectOption("EUR");
  await customer.getByLabel(/^Montant/).fill(amount);
  await customer.getByRole("button", { name: "Obtenir un devis garanti" }).click();
  await expect(customer.getByRole("heading", { name: "Votre devis" })).toBeVisible();
}

/** Étapes 2 et 3 : nouveau bénéficiaire (mobile money), confirmation par code TOTP. */
async function confirmToNewRecipient(firstName: string, lastName: string, msisdn: string): Promise<string> {
  // Formulaire replié dès qu'un bénéficiaire compatible est déjà enregistré.
  if (!(await customer.getByLabel("Prénom(s)").isVisible())) await customer.getByText("Ajouter un bénéficiaire", { exact: true }).click();
  await customer.getByLabel("Prénom(s)").fill(firstName);
  await customer.getByLabel("Nom", { exact: true }).fill(lastName);
  await customer.getByLabel("Numéro de téléphone du bénéficiaire").fill(msisdn);
  await customer.getByLabel("Opérateur").selectOption("orange_money");
  await customer.getByRole("button", { name: "Enregistrer le bénéficiaire" }).click();
  await expect(customer.getByRole("button", { name: "Continuer" })).toBeEnabled();
  await customer.getByRole("button", { name: "Continuer" }).click();
  await customer.getByLabel("Code de votre application d'authentification").fill(await freshTotp(totpSecret));
  await customer.getByRole("button", { name: /^Confirmer et payer/ }).click();
  await customer.waitForURL(/\/transferts\/[0-9a-f-]{36}$/);
  return customer.url();
}

test("envoi de 100 EUR vers le Sénégal : devis garanti, bénéficiaire, confirmation TOTP", async () => {
  await requestQuote("100");
  const quote = customer.locator("section", { has: customer.getByRole("heading", { name: "Votre devis" }) });
  await expect(quote.getByText("100,00 €", { exact: true })).toBeVisible();
  await expect(quote.getByText(/64\s?611/)).toBeVisible();
  transferUrl = await confirmToNewRecipient("Awa", "Diop", "+221771234567");
});

test("sans route de paiement sortant, le transfert est remboursé sur le portefeuille", async () => {
  // Le paiement sortant est déclenché après la réponse ; le statut final est relu.
  await expect(async () => {
    await customer.goto(transferUrl);
    await expect(customer.locator(".badge").first()).toHaveText("Remboursé", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  // Historique complet, montants garantis et bénéficiaire masqué.
  for (const status of ["Payé", "Envoi en préparation", "Remboursement en cours", "Remboursé"]) {
    await expect(customer.getByRole("listitem").filter({ has: customer.getByText(status, { exact: true }) })).toBeVisible();
  }
  await expect(customer.getByRole("definition").filter({ hasText: /^101,99\s€$/ })).toBeVisible();
  await expect(customer.getByRole("definition").filter({ hasText: /^64\s611\sF\sCFA$/ })).toBeVisible();
  await expect(customer.getByRole("definition").filter({ hasText: "•••• 4567 · Orange Money" })).toBeVisible();
  // Remboursement intégral (montant et frais) : le solde revient à 250,00 €.
  await expect((await walletCard()).getByText("250,00 €", { exact: true })).toBeVisible();
});

test("le worker notifie le remboursement au client, une seule fois", async () => {
  const transferId = transferUrl.split("/").pop() ?? "";
  const notifications = (): Promise<{ template: string; status: string }[]> =>
    withOwner(async (client) => {
      const result = await client.query<{ template: string; status: string }>(
        `SELECT n.template, n.status::text AS status
           FROM integrations.customer_notifications n
           JOIN integrations.outbox o ON o.id = n.outbox_id
          WHERE o.aggregate_type = 'transfer' AND o.aggregate_id = $1`,
        [transferId],
      );
      return result.rows;
    });
  // Distribution de l'outbox toutes les 10 s.
  await expect(async () => {
    expect(await notifications()).toEqual([{ template: "transfer_refunded", status: "sent" }]);
  }).toPass({ timeout: 30_000 });
});

test("back-office : transfert remboursé et registre intègre", async ({ staff }) => {
  const reviewer = await staff.member(e2eContext().founders[0].email);
  const transferId = transferUrl.split("/").pop() ?? "";
  await signIn(reviewer, `/transferts/${transferId}`);
  await expect(reviewer.page.getByText("Remboursé", { exact: true }).first()).toBeVisible();
  await reviewer.page.goto(`${e2eContext().adminUrl}/registre`);
  await expect(reviewer.page.getByRole("heading", { name: "Balance générale" })).toBeVisible();
  // Dotation, financement, remboursement : la devise EUR reste équilibrée.
  await expect(reviewer.page.getByRole("row").filter({ has: reviewer.page.getByRole("cell", { name: "EUR", exact: true }) })).toContainText("Équilibré");
  await expect(reviewer.page.getByText("DÉSÉQUILIBRE")).toHaveCount(0);
  // Rapprochement du worker (chaîne de hachage, soldes, balance) au démarrage.
  await expect(reviewer.page.getByText("Sain", { exact: true })).toBeVisible();
  expect(reviewer.errors).toEqual([]);
});

test("bénéficiaire inscrit sur une liste de sanctions : transfert retenu, alerte bloquante", async ({ staff }) => {
  await requestQuote("50");
  // Entrée fictive des listes de test (OFAC SDN et ONU) : « OUSMANE, Amadou Karim ».
  const url = await confirmToNewRecipient("Amadou Karim", "Ousmane", "+221771112233");
  await customer.goto(url);
  await expect(customer.locator(".badge").first()).toHaveText("Vérification en cours");
  await expect(customer.getByText(/Une vérification réglementaire est en cours/)).toBeVisible();
  const reference = ((await customer.getByRole("heading", { level: 1 }).textContent()) ?? "").replace("Transfert", "").trim();
  expect(reference).not.toBe("");
  // Fonds réservés, ni versés ni rendus tant que la conformité n'a pas statué.
  const wallet = await walletCard();
  await expect(wallet.getByText(/Réservé/)).toBeVisible();

  const analyst = await staff.member(e2eContext().founders[1].email);
  await signIn(analyst, "/aml/alertes");
  const row = analyst.page.getByRole("row").filter({ hasText: reference });
  await expect(row.getByRole("link", { name: "SANCTIONS_POTENTIAL_MATCH" })).toBeVisible();
  await expect(row.getByText("bloquante")).toBeVisible();
  expect(analyst.errors).toEqual([]);
});

test("aucune erreur JavaScript ni violation de la CSP côté client", () => {
  expect(errors).toEqual([]);
});
