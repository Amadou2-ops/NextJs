import { defineConfig, devices } from "@playwright/test";

/**
 * Lancé par scripts/stack.ts une fois la pile démarrée (jamais seul).
 * Les parcours partagent la même base et le binôme fondateur : exécution en
 * série, dans l'ordre des fichiers (01-, 02-, …), par un seul worker.
 */
const executablePath = process.env["E2E_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
});
