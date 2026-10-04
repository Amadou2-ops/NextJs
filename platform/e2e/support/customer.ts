import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { e2eContext } from "./context.js";
import { freshTotp, smsCount, waitForSmsCode, withOwner } from "./helpers.js";

/** Inscription complète par le site : numéro, code SMS, mot de passe. */
export async function registerCustomer(page: Page, phone: string, password: string): Promise<void> {
  await page.goto(`${e2eContext().webUrl}/inscription`);
  await page.getByLabel("Numéro de téléphone mobile").fill(phone);
  await page.locator('input[name="consent"]').check();
  const seen = smsCount(phone);
  await page.getByRole("button", { name: "Recevoir un code par SMS" }).click();
  await page.waitForURL("**/inscription/confirmation");
  await page.getByLabel("Code reçu par SMS").fill(await waitForSmsCode(phone, seen));
  await page.getByLabel("Mot de passe (10 caractères au moins)").fill(password);
  await page.getByLabel("Confirmation du mot de passe").fill(password);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("**/verification");
}

/** Active l'application d'authentification depuis la page Sécurité ; renvoie le secret. */
export async function enableTotp(page: Page): Promise<string> {
  await page.goto(`${e2eContext().webUrl}/securite`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Application d'authentification" }) });
  await panel.getByRole("button", { name: "Activer", exact: true }).click();
  await expect(panel.getByRole("img", { name: /QR code/ })).toBeVisible();
  const secret = ((await panel.locator("code").textContent()) ?? "").trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await panel.getByLabel("Code à 6 chiffres").fill(await freshTotp(secret));
  await panel.getByRole("button", { name: "Confirmer l'activation" }).click();
  await expect(panel.getByText("Application d'authentification activée.")).toBeVisible();
  return secret;
}

/**
 * Ouverture du portefeuille, réservée à l'application mobile (requête signée
 * par la clé de l'appareil) : même fonction de la base que l'API, avec le
 * client pour acteur. Renvoie l'identifiant du compte portefeuille.
 */
export async function openWalletAsMobileApp(userId: string, currency: string): Promise<string> {
  return withOwner(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.actor_type', 'customer', true), set_config('app.actor_id', $1, true)", [userId]);
      const wallet = await client.query<{ id: string }>("SELECT ledger.open_customer_account($1, 'customer_wallet', $2) AS id", [userId, currency]);
      await client.query("SELECT ledger.open_customer_account($1, 'customer_hold', $2)", [userId, currency]);
      await client.query("COMMIT");
      const id = wallet.rows[0]?.id;
      if (id === undefined) throw new Error("portefeuille non ouvert");
      return id;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** Compte de dotation (capitaux propres) d'une devise, ouvert par l'exploitant. */
export async function equityAccount(currency: string): Promise<string> {
  return withOwner(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.actor_type', 'system', true), set_config('app.actor_id', 'exploitation', true)");
      const account = await client.query<{ id: string }>("SELECT ledger.open_system_account('equity', $1) AS id", [currency]);
      await client.query("COMMIT");
      const id = account.rows[0]?.id;
      if (id === undefined) throw new Error("compte de dotation non ouvert");
      return id;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
