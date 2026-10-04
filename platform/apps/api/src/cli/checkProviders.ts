import { parseArgs } from "node:util";

import { z } from "zod";

import { ConfigurationError, loadConfig } from "../config/env.js";
import { checkProviders, exitCodeOf, formatReport } from "./providerChecks.js";

/**
 * Contrôle des comptes prestataires (lecture seule) avec la configuration de
 * l'API, avant l'ouverture d'un environnement (sandbox puis live) et après
 * toute rotation d'identifiants :
 *
 *   node dist/cli/checkProviders.js --api-url https://api.transfertplus.example [--strict] [--json]
 *
 * En production (image distroless) : voir deploy/README.md.
 * Code de sortie : 0 si aucun échec (avertissements tolérés sauf --strict),
 * 1 si un contrôle a échoué, 64 si les paramètres ou la configuration sont invalides.
 */

const apiUrlSchema = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "api-url": { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const apiOrigin = apiUrlSchema.safeParse(values["api-url"]);
  if (!apiOrigin.success) {
    process.stderr.write("--api-url est requis : origine publique de l'API (ex. https://api.transfertplus.example)\n");
    process.exit(64);
  }
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(64);
    }
    throw error;
  }
  if (config.isProduction && !apiOrigin.data.startsWith("https:")) {
    process.stderr.write("--api-url doit être en https en production\n");
    process.exit(64);
  }

  const checks = await checkProviders({ config, apiOrigin: apiOrigin.data });
  const strict = values.strict;
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ environment: config.appEnv, apiOrigin: apiOrigin.data, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`Environnement ${config.appEnv}, API ${apiOrigin.data}\n\n${formatReport(checks)}\n`);
  }
  process.exit(exitCodeOf(checks, strict));
}

await main();
