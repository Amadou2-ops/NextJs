import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { e2eContext } from "./context.js";
import { addVirtualAuthenticator, collectBrowserErrors } from "./helpers.js";
import type { VirtualAuthenticator } from "./helpers.js";

/**
 * Membre du personnel dans son propre navigateur, avec une clé de sécurité
 * matérielle virtuelle (CTAP2 USB, non synchronisable). Comme une vraie clé,
 * elle ne quitte pas son navigateur : chaque membre garde le même contexte
 * pendant toute l'exécution (fixture du worker, partagée par les fichiers).
 */
export interface StaffBrowser {
  readonly email: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly authenticator: VirtualAuthenticator;
  readonly errors: string[];
  password: string;
}

class StaffRoster {
  private readonly members = new Map<string, StaffBrowser>();

  constructor(private readonly browser: Browser) {}

  async member(email: string): Promise<StaffBrowser> {
    const existing = this.members.get(email);
    if (existing !== undefined) return existing;
    const context = await this.browser.newContext();
    const page = await context.newPage();
    const member: StaffBrowser = {
      email,
      context,
      page,
      errors: collectBrowserErrors(page),
      authenticator: await addVirtualAuthenticator(context, page, "security-key"),
      password: "",
    };
    this.members.set(email, member);
    return member;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.members.values()].map((member) => member.context.close()));
  }
}

export const test = base.extend<object, { readonly staff: StaffRoster }>({
  staff: [
    async ({ browser }, use) => {
      const roster = new StaffRoster(browser);
      await use(roster);
      await roster.closeAll();
    },
    { scope: "worker" },
  ],
});

export { expect };

/** Enrôlement par le lien d'invitation : mot de passe puis clé de sécurité. */
export async function enroll(staff: StaffBrowser, enrollmentUrl: string, password: string): Promise<void> {
  const { page } = staff;
  await page.goto(enrollmentUrl);
  await page.getByLabel(/^Mot de passe/).fill(password);
  await page.getByLabel("Confirmation du mot de passe").fill(password);
  await page.getByLabel(/Nom de la clé/).fill("Clé E2E");
  await page.getByRole("button", { name: /Enregistrer ma clé/ }).click();
  await expect(page.getByText("Votre compte est activé")).toBeVisible();
  // Le jeton d'invitation (fragment) est retiré de l'adresse après lecture.
  expect(page.url()).not.toContain("invitation=");
  staff.password = password;
}

/**
 * Accès à une page du back-office : connexion mot de passe + clé si la
 * session est absente ou expirée, puis retour vers la page demandée.
 */
export async function signIn(staff: StaffBrowser, path = "/"): Promise<void> {
  const { page } = staff;
  const { adminUrl } = e2eContext();
  await page.goto(`${adminUrl}${path}`);
  if (!new URL(page.url()).pathname.startsWith("/connexion")) return;
  await page.getByLabel("Adresse e-mail professionnelle").fill(staff.email);
  await page.getByLabel("Mot de passe").fill(staff.password);
  await page.getByRole("button", { name: /Continuer avec ma clé/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/connexion"));
}
