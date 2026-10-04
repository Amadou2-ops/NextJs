import { e2eContext } from "../support/context.js";
import { strongPassword } from "../support/helpers.js";
import { enroll, expect, signIn, test } from "../support/staff.js";
import type { StaffBrowser } from "../support/staff.js";

/**
 * Back-office : enrôlement du binôme fondateur (mot de passe + clé matérielle),
 * connexion, règle des quatre yeux sur l'invitation d'un membre, habilitations
 * d'un agent du support, protections du BFF.
 */
test.describe.configure({ mode: "serial" });

const SUPPORT_EMAIL = "agent.support@transfertplus.example";
let founderA: StaffBrowser;
let founderB: StaffBrowser;
let enrollmentLink = "";

test.beforeAll(async ({ staff }) => {
  const [a, b] = e2eContext().founders;
  founderA = await staff.member(a.email);
  founderB = await staff.member(b.email);
});

test("enrôlement des deux fondateurs par lien d'invitation et clé de sécurité", async () => {
  const [a, b] = e2eContext().founders;
  await enroll(founderA, a.enrollmentUrl, strongPassword("fondatrice-a"));
  await enroll(founderB, b.enrollmentUrl, strongPassword("fondateur-b"));
  // Un lien d'enrôlement ne sert qu'une fois (nouveau document : un simple
  // changement de fragment ne recharge pas la page).
  await founderA.page.goto("about:blank");
  await founderA.page.goto(a.enrollmentUrl);
  await founderA.page.getByLabel(/^Mot de passe/).fill(founderA.password);
  await founderA.page.getByLabel("Confirmation du mot de passe").fill(founderA.password);
  await founderA.page.getByLabel(/Nom de la clé/).fill("Seconde clé");
  await founderA.page.getByRole("button", { name: /Enregistrer ma clé/ }).click();
  await expect(founderA.page.getByText(/Cette invitation est invalide, expirée ou déjà utilisée/)).toBeVisible();
  await expect(founderA.page.getByText("Votre compte est activé")).toHaveCount(0);
});

test("mot de passe erroné : refus générique, adresse conservée, mot de passe effacé", async () => {
  const { page } = founderA;
  await page.goto(`${e2eContext().adminUrl}/connexion`);
  await page.getByLabel("Adresse e-mail professionnelle").fill(founderA.email);
  await page.getByLabel("Mot de passe").fill("mauvais-mot-de-passe");
  await page.getByRole("button", { name: /Continuer avec ma clé/ }).click();
  await expect(page.getByText("Identifiants ou clé de sécurité refusés.")).toBeVisible();
  await expect(page.getByLabel("Adresse e-mail professionnelle")).toHaveValue(founderA.email);
  await expect(page.getByLabel("Mot de passe")).toHaveValue("");
});

test("connexion par clé de sécurité, retour à la page demandée, cookie chiffré", async () => {
  await signIn(founderA, "/personnel/inviter");
  expect(new URL(founderA.page.url()).pathname).toBe("/personnel/inviter");
  const session = (await founderA.context.cookies()).find((cookie) => cookie.name === "__Host-tpa_session");
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  expect(session?.value).not.toContain("art_");
});

test("invitation d'un agent du support : le demandeur ne peut pas l'approuver", async () => {
  const { page } = founderA;
  await page.getByLabel("Nom complet").fill("Agent Support");
  await page.getByLabel("Adresse e-mail professionnelle").fill(SUPPORT_EMAIL);
  await page.getByLabel("Support client").check();
  await page.getByLabel(/Plages d'adresses autorisées/).fill("127.0.0.1/32\n::1/128");
  await page.getByLabel("Justification").fill("Renfort de l'équipe support pour le lancement.");
  await page.getByRole("button", { name: "Créer la demande d'invitation" }).click();
  await expect(page.getByText(/Demande créée : un second membre/)).toBeVisible();

  await page.goto(`${e2eContext().adminUrl}/approbations`);
  await page.getByRole("link", { name: "Invitation d'un membre du personnel" }).first().click();
  await expect(page.getByText(/Vous êtes l'auteur de cette demande/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approuver et exécuter" })).toHaveCount(0);
});

test("approbation par le second fondateur : lien d'enrôlement remis une seule fois", async () => {
  await signIn(founderB);
  const { page } = founderB;
  await expect(page.getByText(/demande\(s\) à valider/)).toBeVisible();
  await page.goto(`${e2eContext().adminUrl}/approbations`);
  await page.getByRole("link", { name: "Invitation d'un membre du personnel" }).first().click();
  await expect(page.getByText(SUPPORT_EMAIL)).toBeVisible();
  await page.getByLabel(/J'ai vérifié le contenu/).check();
  await page.getByRole("button", { name: "Approuver et exécuter" }).click();
  await expect(page.getByText("Invitation approuvée")).toBeVisible();
  const secret = page.locator("code.secret");
  await expect(secret).toHaveCount(1);
  enrollmentLink = ((await secret.textContent()) ?? "").trim();
  expect(enrollmentLink).toMatch(new RegExp(`^${e2eContext().adminUrl}/enrolement#invitation=inv_[A-Za-z0-9_-]{43}$`));
});

test("vues du super-administrateur et chaîne d'audit intacte", async () => {
  const { page } = founderB;
  const { adminUrl } = e2eContext();
  await page.goto(`${adminUrl}/personnel?status=invited`);
  await expect(page.getByRole("link", { name: "Agent Support" })).toBeVisible();
  await page.goto(`${adminUrl}/audit?action=approval.executed`);
  await expect(page.getByText(/Chaîne de hachage intacte/)).toBeVisible();
  await expect(page.getByText("approval.executed").first()).toBeVisible();
  for (const [path, heading] of [
    ["/registre", "Balance générale"],
    ["/clients", "Clients"],
    ["/transferts", "Transferts"],
    ["/aml/alertes", "Alertes LCB-FT"],
    ["/kyc", /Vérifications d'identité/],
  ] as const) {
    await page.goto(`${adminUrl}${path}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("agent du support enrôlé : navigation et accès limités à ses habilitations", async ({ staff }) => {
  const agent = await staff.member(SUPPORT_EMAIL);
  await enroll(agent, enrollmentLink, strongPassword("support"));
  await signIn(agent);
  const navigation = agent.page.getByRole("navigation", { name: "Navigation du back-office" });
  await expect(navigation.getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Personnel" })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "Approbations" })).toHaveCount(0);
  await agent.page.goto(`${e2eContext().adminUrl}/personnel`);
  await expect(agent.page.getByText(/Cette page exige l'habilitation/)).toBeVisible();
  expect(agent.errors).toEqual([]);
});

test("mutation d'une autre origine refusée ; déconnexion effective", async () => {
  const { page, context } = founderB;
  const { adminUrl } = e2eContext();
  const forged = await page.request.post(`${adminUrl}/approbations`, { headers: { origin: "https://attaquant.example" }, data: "x" });
  expect(forged.status()).toBe(403);
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL("**/connexion");
  expect((await context.cookies()).some((cookie) => cookie.name === "__Host-tpa_session")).toBe(false);
  await page.goto(`${adminUrl}/clients`);
  await page.waitForURL("**/connexion?suite=%2Fclients");
});

test("aucune erreur JavaScript ni violation de la CSP", () => {
  // Les refus attendus (401 du mot de passe erroné) sont traités côté serveur, sans erreur de page.
  expect([...founderA.errors, ...founderB.errors]).toEqual([]);
});
