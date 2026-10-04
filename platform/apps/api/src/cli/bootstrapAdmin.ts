import { parseArgs } from "node:util";

import pg from "pg";
import { z } from "zod";

import { generateInvitationToken } from "../modules/backoffice/adminAuth.service.js";
import { allowedIpRangeSchema } from "../modules/backoffice/approvalActions.js";

/**
 * Amorçage du binôme fondateur de super-administrateurs (installation) : à
 * exécuter DEUX fois, une par fondateur, car toute attribution de droits
 * exige ensuite la double validation (un demandeur et un approbateur
 * distincts). S'exécute avec la connexion PROPRIÉTAIRE du schéma (celle des
 * migrations) : le rôle applicatif n'a pas le droit d'appeler
 * backoffice.bootstrap_super_admin, qui se ferme définitivement après deux
 * comptes ou dès la première invitation émise par un membre (migration 0024).
 *
 *   BOOTSTRAP_DATABASE_URL=postgres://… ADMIN_ENROLLMENT_URL=https://admin…/enrolement \
 *     node dist/cli/bootstrapAdmin.js --email chef@… --name "Prénom Nom" --ip-range 203.0.113.0/24
 *
 * Le lien d'enrôlement (valable 24 h) est affiché une seule fois ; seule son
 * empreinte est conservée en base.
 */

const argumentsSchema = z.strictObject({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  name: z.string().trim().min(2).max(120),
  ranges: z.array(allowedIpRangeSchema).min(1).max(10),
  databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),
  enrollmentUrl: z.url({ protocol: /^https?$/ }),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "ip-range": { type: "string", multiple: true },
    },
    strict: true,
  });
  const parsed = argumentsSchema.safeParse({
    email: values.email,
    name: values.name,
    ranges: values["ip-range"] ?? [],
    databaseUrl: process.env["BOOTSTRAP_DATABASE_URL"],
    enrollmentUrl: process.env["ADMIN_ENROLLMENT_URL"],
  });
  if (!parsed.success) {
    process.stderr.write(`Paramètres invalides :\n${parsed.error.issues.map((issue) => `  - ${issue.path.join(".")} : ${issue.message}`).join("\n")}\n`);
    process.exit(64);
  }
  const options = parsed.data;
  const invitation = generateInvitationToken();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ id: string }>("SELECT backoffice.bootstrap_super_admin($1, $2, $3::cidr[], $4, $5) AS id", [
      options.email,
      options.name,
      options.ranges,
      invitation.sha256,
      expiresAt,
    ]);
    const url = new URL(options.enrollmentUrl);
    url.hash = `invitation=${invitation.token}`;
    process.stdout.write(
      `Super-administrateur ${result.rows[0]?.id ?? "?"} créé (statut : invité).\n` +
        `Lien d'enrôlement, à transmettre par un canal sûr, valable jusqu'au ${expiresAt.toISOString()} :\n${url.toString()}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Échec de l'amorçage : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
