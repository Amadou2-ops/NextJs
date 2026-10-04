import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { equityAccount } from "./customer.js";
import { approveKycAsProvider, customerRegisteredSince, smsCount, waitForSmsCode, withOwner } from "./helpers.js";
import type { TestSecureElement } from "./secureElement.js";

/**
 * Service local du parcours mobile (127.0.0.1 seulement), appelé par le test
 * Flutter :
 *
 *   /secure-element/*   composant sécurisé de l'appareil (clé, signature,
 *                       attestation) — voir secureElement.ts ;
 *   /control/*          ce que fourniraient des services externes : code SMS
 *                       (journal de l'API, SMS_PROVIDER=log), décision du
 *                       prestataire KYC, approvisionnement du portefeuille
 *                       par l'exploitant.
 */

type Json = Readonly<Record<string, unknown>>;

async function readJson(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("corps trop volumineux");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("objet JSON attendu");
  return parsed as Json;
}

function text(body: Json, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`champ ${key} attendu`);
  return value;
}

function respond(response: ServerResponse, status: number, body?: Json): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Crédit du portefeuille par l'exploitant (compte de dotation → portefeuille du client). */
export async function creditWallet(userId: string, currency: string, amountMinor: string): Promise<void> {
  if (!/^[1-9]\d{0,14}$/.test(amountMinor)) throw new Error("montant invalide");
  const equity = await equityAccount(currency);
  await withOwner(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.actor_type', 'system', true), set_config('app.actor_id', 'exploitation', true)");
      const wallet = await client.query<{ id: string }>(
        "SELECT id FROM ledger.accounts WHERE owner_user_id = $1 AND account_type = 'customer_wallet' AND currency = $2",
        [userId, currency],
      );
      const walletId = wallet.rows[0]?.id;
      if (walletId === undefined) throw new Error(`aucun portefeuille ${currency} pour ${userId}`);
      await client.query(
        `SELECT ledger.post_journal($1, 'adjustment',
                 jsonb_build_array(
                   jsonb_build_object('account_id', $2::uuid, 'direction', 'debit', 'amount', $4::bigint, 'currency', $5::text),
                   jsonb_build_object('account_id', $3::uuid, 'direction', 'credit', 'amount', $4::bigint, 'currency', $5::text)),
                 'Approvisionnement du portefeuille (recette mobile)', 'system:e2e')`,
        [`e2e-mobile-credit:${randomUUID()}`, equity, walletId, amountMinor, currency],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function startMobileControl(element: TestSecureElement, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = `${request.method ?? "GET"} ${url.pathname}`;
    void (async () => {
      try {
        switch (route) {
          case "POST /secure-element/keys":
            respond(response, 200, { publicKey: element.createKey().toString("base64") });
            return;
          case "GET /secure-element/keys":
            respond(response, 200, { publicKey: element.publicKey()?.toString("base64") ?? null });
            return;
          case "DELETE /secure-element/keys":
            element.deleteKey();
            respond(response, 204);
            return;
          case "POST /secure-element/sign": {
            const body = await readJson(request);
            respond(response, 200, { signature: element.sign(Buffer.from(text(body, "message"), "base64")).toString("base64") });
            return;
          }
          case "POST /secure-element/attest": {
            const body = await readJson(request);
            respond(response, 200, await element.attest(Buffer.from(text(body, "clientDataHash"), "base64")));
            return;
          }
          case "GET /control/sms-count":
            respond(response, 200, { count: smsCount(url.searchParams.get("phone") ?? "") });
            return;
          case "GET /control/sms-code": {
            const phone = url.searchParams.get("phone") ?? "";
            const seen = Number(url.searchParams.get("seen") ?? "0");
            respond(response, 200, { code: await waitForSmsCode(phone, seen) });
            return;
          }
          case "POST /control/kyc/approve": {
            const body = await readJson(request);
            const userId = await customerRegisteredSince(new Date(text(body, "since")));
            await approveKycAsProvider(userId, { firstName: text(body, "firstName"), lastName: text(body, "lastName"), dateOfBirth: text(body, "dateOfBirth") });
            respond(response, 200, { userId });
            return;
          }
          case "POST /control/wallet/credit": {
            const body = await readJson(request);
            await creditWallet(text(body, "userId"), text(body, "currency"), text(body, "amountMinor"));
            respond(response, 204);
            return;
          }
          default:
            respond(response, 404, { error: `route inconnue : ${route}` });
        }
      } catch (error: unknown) {
        respond(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  return server;
}
