import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { e2eContext } from "../support/context.js";
import { enableTotp, registerCustomer } from "../support/customer.js";
import { addVirtualAuthenticator, collectBrowserErrors, freshTotp, frenchMobileNumber, smsCount, strongPassword } from "../support/helpers.js";

/**
 * Site client : inscription par SMS, session chiffrée, second facteur TOTP,
 * passkey, reconnexions, protections du BFF. Un même client, du premier
 * écran à la connexion sans mot de passe.
 */
test.describe.configure({ mode: "serial" });

const phone = frenchMobileNumber();
const password = strongPassword("client");
let totpSecret = "";
let context: BrowserContext;
let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  errors = collectBrowserErrors(page);
});

test.afterAll(async () => {
  await context.close();
});

test("accueil : estimation publique au taux du jour, CSP à nonce", async () => {
  const { webUrl } = e2eContext();
  const response = await page.goto(webUrl);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: /Envoyez de l'argent/ })).toBeVisible();

  const calculator = page.getByRole("region", { name: "Combien recevront vos proches ?" });
  await calculator.getByLabel("Vers").selectOption("SN");
  await calculator.getByLabel(/Vous envoyez/).fill("100");
  // 1 EUR = 603,48 / 0,92 XOF, marge de 1,5 % : 100 EUR → 64 611 XOF ; frais fixes 1,99 EUR.
  await expect(calculator.getByText(/64\s?611/)).toBeVisible();
  await expect(calculator.getByText("1,99 €", { exact: true })).toBeVisible();
  await expect(calculator.getByText("101,99 €", { exact: true })).toBeVisible();
});

test("inscription par code SMS, cookie de session chiffré et strict", async () => {
  const { webUrl } = e2eContext();
  await registerCustomer(page, phone, password);
  await expect(page.getByRole("heading", { name: "Vérification d'identité" })).toBeVisible();

  const session = (await context.cookies()).find((cookie) => cookie.name === "__Host-tp_session");
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  // JWE compact (dir + A256GCM) : aucun jeton de l'API lisible par le navigateur.
  const [header, encryptedKey, ...rest] = session?.value.split(".") ?? [];
  expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toMatchObject({ alg: "dir", enc: "A256GCM" });
  expect(encryptedKey).toBe("");
  expect(rest).toHaveLength(3);

  await page.goto(`${webUrl}/tableau-de-bord`);
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
  await expect(page.getByText("Vérifiez votre identité pour envoyer")).toBeVisible();
});

test("application d'authentification (TOTP) activée", async () => {
  totpSecret = await enableTotp(page);
  await expect(page.getByText("cette session")).toBeVisible();
});

test("passkey enregistrée sur l'appareil", async () => {
  const { webUrl } = e2eContext();
  await addVirtualAuthenticator(context, page, "platform");
  await page.goto(`${webUrl}/securite`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Passkeys" }) });
  await panel.getByLabel("Nom de l'appareil (facultatif)").fill("Navigateur E2E");
  await panel.getByRole("button", { name: "Ajouter une passkey" }).click();
  await expect(panel.getByText("Passkey enregistrée.")).toBeVisible();
});

test("déconnexion : session effacée, espace client fermé", async () => {
  const { webUrl } = e2eContext();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL(`${webUrl}/`);
  expect((await context.cookies()).some((cookie) => cookie.name === "__Host-tp_session")).toBe(false);
  await page.goto(`${webUrl}/tableau-de-bord`);
  await page.waitForURL("**/connexion?suite=%2Ftableau-de-bord");
});

test("mot de passe erroné refusé, puis connexion avec le second facteur TOTP", async () => {
  await page.getByLabel("Numéro de téléphone").fill(phone);
  await page.getByLabel("Mot de passe").fill("mauvais-mot-de-passe");
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await expect(page.getByText("Numéro de téléphone ou mot de passe incorrect.")).toBeVisible();
  await expect(page.getByLabel("Numéro de téléphone")).toHaveValue(phone);
  await expect(page.getByLabel("Mot de passe")).toHaveValue("");

  const sms = smsCount(phone);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await page.waitForURL("**/connexion/verification");
  // Le TOTP activé remplace le SMS comme second facteur.
  await expect(page.getByText("Saisissez le code affiché par votre application d'authentification.")).toBeVisible();
  expect(smsCount(phone)).toBe(sms);
  await page.getByLabel("Code à 6 chiffres").fill(await freshTotp(totpSecret));
  await page.getByRole("button", { name: "Valider" }).click();
  await page.waitForURL("**/tableau-de-bord");
});

test("connexion sans mot de passe par passkey", async () => {
  const { webUrl } = e2eContext();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL(`${webUrl}/`);
  await page.goto(`${webUrl}/connexion`);
  await page.getByRole("button", { name: "Se connecter avec une passkey" }).click();
  await page.waitForURL("**/tableau-de-bord");
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
});

test("mutation d'une autre origine refusée par le BFF", async () => {
  const { webUrl } = e2eContext();
  const forged = await page.request.post(`${webUrl}/securite`, { headers: { origin: "https://attaquant.example" }, data: "x" });
  expect(forged.status()).toBe(403);
});

test("aucune erreur JavaScript ni violation de la CSP", () => {
  expect(errors).toEqual([]);
});
