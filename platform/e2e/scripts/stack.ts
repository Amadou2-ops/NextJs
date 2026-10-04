import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { CONTEXT_FILE, RUNTIME_DIR } from "../support/context.js";
import type { E2EContext, Founder } from "../support/context.js";
import { startMobileControl } from "../support/mobileControl.js";
import { TestSecureElement } from "../support/secureElement.js";

/**
 * Pile réelle des tests de bout en bout, puis Playwright :
 *
 *   1. base neuve `transfertplus_e2e` : migrations, données de référence, et la
 *      configuration qu'un exploitant ferait (corridor France → Sénégal, marge,
 *      frais) avec des taux tels que la tâche fx-refresh les enregistre ;
 *   2. Redis vidé (limiteurs de débit), clés de signature et de chiffrement neuves ;
 *   3. listes de criblage de test (formats officiels OFAC et ONU, entrées
 *      fictives) servies localement et importées par le vrai worker ;
 *   4. API (SMS de développement journalisés), worker, binôme fondateur du
 *      back-office, site client et back-office en build de production ;
 *   5. `playwright test` (arguments transmis), puis arrêt de tous les processus.
 *
 * E2E_SUITE=mobile : parcours de l'application Flutter (apps/mobile/e2e_test)
 * à la place de Playwright. Le site et le back-office ne sont pas démarrés ;
 * le composant sécurisé de l'appareil et les services externes (SMS, KYC,
 * approvisionnement) sont fournis par support/mobileControl.ts, et l'API
 * accepte l'autorité App Attest de TEST de la pile (développement seulement).
 * Binaire Flutter : E2E_FLUTTER (défaut : `flutter`).
 *
 * Aucun prestataire n'est simulé côté API : sans route de paiement sortant
 * configurée, un transfert financé est remboursé (comportement de production).
 *
 *   pnpm --filter @transfertplus/web build && pnpm --filter @transfertplus/admin build
 *   E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432 E2E_REDIS_URL=redis://127.0.0.1:6379/9 \
 *     pnpm --filter @transfertplus/e2e e2e
 */

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E_ROOT = join(PLATFORM, "e2e");
const DATABASE = "transfertplus_e2e";
const API_PORT = 8080;
const WEB_PORT = 3000;
const ADMIN_PORT = 3001;
const LISTS_PORT = 8099;
const MOBILE_CONTROL_PORT = 8098;
const APP_ATTEST_APP_ID = "EQUIPE1234.com.transfertplus.app";
const SUITE = process.env["E2E_SUITE"] ?? "web";
if (SUITE !== "web" && SUITE !== "mobile") throw new Error(`E2E_SUITE inconnue : ${SUITE} (web ou mobile)`);
const PII_KEY_ID = "pii-e2e-1";

const postgresUrl = (process.env["E2E_POSTGRES_URL"] ?? "postgres://postgres:postgres@127.0.0.1:5432").replace(/\/+$/, "");
const redisUrl = new URL(process.env["E2E_REDIS_URL"] ?? "redis://127.0.0.1:6379/9");
const ownerDatabaseUrl = `${postgresUrl}/${DATABASE}`;

const children: ChildProcess[] = [];
const servers: Server[] = [];
let stopping = false;

function step(message: string): void {
  process.stdout.write(`▸ ${message}\n`);
}

function run(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} : code ${String(code)}\n${output}`));
    });
  });
}

function startServer(name: string, command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const logFile = join(RUNTIME_DIR, `${name}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code, signal) => {
    if (!stopping && signal === null && code !== 0) process.stderr.write(`${name} arrêté (code ${String(code)}) — voir ${logFile}\n`);
  });
  children.push(child);
  return logFile;
}

async function waitFor(url: string, name: string, logFile: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // Pas encore à l'écoute.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${name} ne répond pas sur ${url}\n${tail(logFile)}`);
}

function tail(file: string, lines = 40): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n") : "(journal absent)";
}

/** FLUSHDB sur la base Redis dédiée, sans client supplémentaire (protocole RESP). */
async function flushRedis(url: URL): Promise<void> {
  const index = url.pathname.replace("/", "") || "0";
  if (!/^\d{1,2}$/.test(index)) throw new Error(`E2E_REDIS_URL : index de base invalide (${index})`);
  const command = (...parts: string[]): string => `*${parts.length.toString()}\r\n${parts.map((part) => `$${Buffer.byteLength(part).toString()}\r\n${part}\r\n`).join("")}`;
  const auth = url.password === "" ? "" : command("AUTH", decodeURIComponent(url.password));
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || "6379") }, () => {
      socket.write(`${auth}${command("SELECT", index)}${command("FLUSHDB")}`);
    });
    let reply = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("Redis : délai dépassé")));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      const answers = reply.split("\r\n").filter((line) => line.length > 0);
      if (answers.some((line) => line.startsWith("-"))) socket.destroy(new Error(`Redis : ${reply.trim()}`));
      else if (answers.length >= (auth === "" ? 2 : 3)) {
        socket.end();
        resolve();
      }
    });
    socket.on("error", reject);
  });
}

function signingKey(kid: string): { readonly publicJwk: object; readonly privateJwk: object } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicJwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" },
    privateJwk: { ...privateKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" },
  };
}

/** Serveur des listes de criblage de test (fixtures/listes), à la place des sites officiels. */
async function serveScreeningLists(): Promise<string> {
  const files: Readonly<Record<string, string>> = {
    "/SDN.CSV": "text/csv",
    "/ALT.CSV": "text/csv",
    "/consolidated.xml": "application/xml",
  };
  const server = createServer((request, response) => {
    const type = files[request.url ?? ""];
    if (request.method !== "GET" || type === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": type }).end(readFileSync(join(E2E_ROOT, "fixtures", "listes", (request.url ?? "").slice(1))));
  });
  await new Promise<void>((resolve) => server.listen(LISTS_PORT, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${LISTS_PORT.toString()}`;
}

/** Attend que le worker ait importé les listes de sanctions (versions courantes). */
async function waitForScreeningLists(workerLog: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  const owner = new pg.Client({ connectionString: ownerDatabaseUrl });
  await owner.connect();
  try {
    while (Date.now() < deadline) {
      const current = await owner.query<{ count: string }>("SELECT count(*) AS count FROM aml.list_versions WHERE is_current AND kind = 'sanctions'");
      if (Number(current.rows[0]?.count ?? "0") >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    await owner.end();
  }
  throw new Error(`listes de criblage non importées par le worker\n${tail(workerLog)}`);
}

async function resetDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: `${postgresUrl}/postgres` });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  const env = { ...process.env, APP_ENV: "development", DATABASE_URL: ownerDatabaseUrl, DATABASE_SSL_MODE: "disable" };
  await run(process.execPath, ["--import", "tsx", "src/cli.ts", "migrate"], { cwd: join(PLATFORM, "db"), env });
  await run(process.execPath, ["--import", "tsx", "src/cli.ts", "seed"], { cwd: join(PLATFORM, "db"), env });

  // Configuration initiale d'exploitation (modifiable ensuite depuis le
  // back-office : parcours 04-parametrage) et taux tels que la tâche
  // fx-refresh les enregistre : 1 USD = 0,92 EUR = 603,48 XOF.
  const owner = new pg.Client({ connectionString: ownerDatabaseUrl });
  await owner.connect();
  try {
    await owner.query("UPDATE ref.countries SET can_send = true WHERE alpha2 = 'FR'");
    await owner.query("UPDATE ref.countries SET can_receive = true WHERE alpha2 = 'SN'");
    await owner.query("UPDATE ref.currencies SET is_enabled = true WHERE code IN ('EUR', 'USD', 'XOF')");
    await owner.query("UPDATE payments.providers SET is_enabled = true WHERE code = 'flutterwave'");
    await owner.query(
      `INSERT INTO payments.payout_corridors (destination_country, destination_currency, payout_method, provider, min_amount, max_amount,
                                              cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled)
       VALUES ('SN', 'XOF', 'mobile_money', 'flutterwave', 500, 2000000, 0, 50, 5, true)`,
    );
    await owner.query("INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps, priority) VALUES ('EUR', 'XOF', 150, 10)");
    await owner.query("INSERT INTO transfers.fee_schedules (source_currency, fixed_fee, percentage_bps, min_fee, priority) VALUES ('EUR', 199, 0, 0, 0)");
    await owner.query(
      `INSERT INTO fx.rate_snapshots (provider, base_currency, quote_currency, rate, provider_timestamp)
       VALUES ('open_exchange_rates', 'USD', 'EUR', 0.92, now() - interval '5 minutes'),
              ('open_exchange_rates', 'USD', 'XOF', 603.48, now() - interval '5 minutes')`,
    );
  } finally {
    await owner.end();
  }
}

function prepareStandalone(app: "web" | "admin"): string {
  const appRoot = join(PLATFORM, "apps", app);
  const standalone = join(appRoot, ".next", "standalone", "apps", app);
  if (!existsSync(join(standalone, "server.js"))) {
    throw new Error(`build de production absent pour apps/${app} : pnpm --filter @transfertplus/${app} build`);
  }
  // Comme l'image Docker : les ressources statiques accompagnent le serveur autonome.
  cpSync(join(appRoot, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
  return standalone;
}

async function bootstrapFounder(email: string, name: string, enrollmentUrl: string): Promise<Founder> {
  const output = await run(
    process.execPath,
    ["--import", "tsx", "src/cli/bootstrapAdmin.ts", "--email", email, "--name", name, "--ip-range", "127.0.0.1/32", "--ip-range", "::1/128"],
    { cwd: join(PLATFORM, "apps", "api"), env: { ...process.env, BOOTSTRAP_DATABASE_URL: ownerDatabaseUrl, ADMIN_ENROLLMENT_URL: enrollmentUrl } },
  );
  const link = /https?:\/\/\S+#invitation=inv_[A-Za-z0-9_-]{43}/.exec(output)?.[0];
  if (link === undefined) throw new Error(`lien d'enrôlement absent :\n${output}`);
  return { email, name, enrollmentUrl: link };
}

async function main(): Promise<number> {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const webStandalone = SUITE === "web" ? prepareStandalone("web") : null;
  const adminStandalone = SUITE === "web" ? prepareStandalone("admin") : null;
  // Autorité App Attest de test : l'API ne l'accepte qu'en développement.
  const secureElement = await TestSecureElement.create(APP_ATTEST_APP_ID);
  const attestRootPath = join(RUNTIME_DIR, "app-attest-test-root.pem");
  writeFileSync(attestRootPath, secureElement.rootPem);

  step(`base ${DATABASE} : migrations, données de référence, corridor FR → SN`);
  await resetDatabase();
  step("Redis : limiteurs remis à zéro");
  await flushRedis(redisUrl);

  const piiKeyBase64 = randomBytes(32).toString("base64");
  const customer = signingKey("customer-e2e-1");
  const staff = signingKey("admin-e2e-1");
  const apiUrl = `http://127.0.0.1:${API_PORT.toString()}`;
  const webUrl = `http://localhost:${WEB_PORT.toString()}`;
  const adminUrl = `http://localhost:${ADMIN_PORT.toString()}`;
  const appDatabaseUrl = `${ownerDatabaseUrl}?options=${encodeURIComponent("-c role=app_api")}`;

  const listsUrl = await serveScreeningLists();
  const apiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "development",
    APP_VERSION: "0.0.0-e2e",
    HOST: "127.0.0.1",
    PORT: API_PORT.toString(),
    TRUST_PROXY_HOPS: "1",
    LOG_LEVEL: "info",
    DATABASE_URL: appDatabaseUrl,
    DATABASE_SSL_MODE: "disable",
    REDIS_URL: redisUrl.toString(),
    CORS_ALLOWED_ORIGINS: webUrl,
    JWT_ISSUER: apiUrl,
    JWT_CUSTOMER_PUBLIC_JWKS: JSON.stringify({ keys: [customer.publicJwk] }),
    JWT_CUSTOMER_SIGNING_KEY: JSON.stringify(customer.privateJwk),
    JWT_ADMIN_PUBLIC_JWKS: JSON.stringify({ keys: [staff.publicJwk] }),
    JWT_ADMIN_SIGNING_KEY: JSON.stringify(staff.privateJwk),
    PII_KEYRING: JSON.stringify({ activeKeyId: PII_KEY_ID, keys: { [PII_KEY_ID]: piiKeyBase64 } }),
    BLIND_INDEX_KEY: randomBytes(32).toString("base64"),
    OTP_HMAC_KEY: randomBytes(32).toString("base64"),
    SMS_PROVIDER: "log",
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: webUrl,
    PASSWORD_BREACH_CHECK: "disabled",
    ADMIN_WEBAUTHN_RP_ID: "localhost",
    ADMIN_WEBAUTHN_ORIGINS: adminUrl,
    ADMIN_ENROLLMENT_URL: `${adminUrl}/enrolement`,
    AML_OFAC_SDN_URL: `${listsUrl}/SDN.CSV`,
    AML_OFAC_ALT_URL: `${listsUrl}/ALT.CSV`,
    AML_UN_LIST_URL: `${listsUrl}/consolidated.xml`,
    APPLE_APP_ATTEST_APP_IDS: APP_ATTEST_APP_ID,
    APPLE_APP_ATTEST_TEST_ROOT_CERT_PATH: attestRootPath,
  };

  step("API et worker (import des listes de criblage)");
  const apiDir = join(PLATFORM, "apps", "api");
  const apiLogFile = startServer("api", process.execPath, ["--import", "tsx", "src/server.ts"], apiDir, apiEnv);
  const workerLog = startServer("worker", process.execPath, ["--import", "tsx", "src/worker.ts"], apiDir, apiEnv);
  await waitFor(`${apiUrl}/v1/health`, "API", apiLogFile);
  await waitForScreeningLists(workerLog);

  step("binôme fondateur du back-office");
  const founders: [Founder, Founder] = [
    await bootstrapFounder("fondatrice.a@transfertplus.example", "Fondatrice A", `${adminUrl}/enrolement`),
    await bootstrapFounder("fondateur.b@transfertplus.example", "Fondateur B", `${adminUrl}/enrolement`),
  ];

  const context: E2EContext = { apiUrl, webUrl, adminUrl, ownerDatabaseUrl, apiLogFile, piiKeyId: PII_KEY_ID, piiKeyBase64, founders };
  writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));

  if (SUITE === "mobile") {
    step("composant sécurisé et services de contrôle du parcours mobile");
    servers.push(await startMobileControl(secureElement, MOBILE_CONTROL_PORT));
    step("application mobile (flutter test e2e_test)");
    const flutter = spawn(
      process.env["E2E_FLUTTER"] ?? "flutter",
      ["test", "e2e_test", `--dart-define=E2E_API_URL=${apiUrl}`, `--dart-define=E2E_CONTROL_URL=http://127.0.0.1:${MOBILE_CONTROL_PORT.toString()}`, ...process.argv.slice(2)],
      { cwd: join(PLATFORM, "apps", "mobile"), env: process.env, stdio: "inherit" },
    );
    return new Promise((resolve) => {
      flutter.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
  }
  if (webStandalone === null || adminStandalone === null) throw new Error("builds du site et du back-office absents");

  step("site client et back-office (builds de production)");
  const bffEnv = (origin: string, port: number): NodeJS.ProcessEnv => ({
    ...process.env,
    NODE_ENV: "production",
    PORT: port.toString(),
    HOSTNAME: "127.0.0.1",
    API_BASE_URL: apiUrl,
    APP_ORIGIN: origin,
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  });
  const webLog = startServer("web", process.execPath, ["server.js"], webStandalone, bffEnv(webUrl, WEB_PORT));
  const adminLog = startServer("admin", process.execPath, ["server.js"], adminStandalone, bffEnv(adminUrl, ADMIN_PORT));
  await waitFor(`${webUrl}/`, "site client", webLog);
  await waitFor(`${adminUrl}/connexion`, "back-office", adminLog);

  step("Playwright");
  const playwright = spawn(process.execPath, [join(E2E_ROOT, "node_modules", "@playwright", "test", "cli.js"), "test", ...process.argv.slice(2)], {
    cwd: E2E_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  return new Promise((resolve) => {
    playwright.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function stop(): Promise<void> {
  stopping = true;
  for (const server of servers) server.close();
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
          child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await stop();
}
process.exit(exitCode);
