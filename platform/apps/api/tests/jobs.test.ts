import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { AmlListsJob } from "../src/jobs/amlLists.job.js";
import { FxRefreshJob } from "../src/jobs/fxRefresh.job.js";
import { KycSyncJob } from "../src/jobs/kycSync.job.js";
import { MaintenanceJob } from "../src/jobs/maintenance.job.js";
import { PaymentSyncJob } from "../src/jobs/paymentSync.job.js";
import { WebhookRetryJob } from "../src/jobs/webhookRetry.job.js";
import { ListIngestionService } from "../src/modules/aml/listIngestion.service.js";
import type { ListSource } from "../src/modules/aml/lists/sources.js";
import type { KycService } from "../src/modules/kyc/kyc.service.js";
import type { RateIngestionService } from "../src/modules/fx/rateIngestion.service.js";
import type { RateProvider } from "../src/modules/fx/providers/types.js";
import type { PaymentOrchestrator } from "../src/modules/transfers/payment.orchestrator.js";
import type { WebhookInbox } from "../src/modules/webhooks/webhookInbox.js";
import { buildTestConfig, createApiPool, createOwnerPool, createTestKeys, silentLogger } from "./support/fixtures.js";

/**
 * Jobs du worker : chacun délègue à son service, signale ses échecs (pour
 * l'alerte du planificateur) et ne masque jamais une source en panne.
 */

const owner = createOwnerPool();
const apiPool = createApiPool(buildTestConfig(await createTestKeys()));
afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

describe("jobs du worker", () => {
  it("met à jour les listes disponibles et signale nommément celles en échec", async () => {
    const name = `jobs_${randomUUID().slice(0, 8)}`;
    const entries = [{ externalId: "J-1", entryType: "individual" as const, primaryName: "Test Personne", aliases: [], birthDates: [], countries: [], programs: [] }];
    const healthy: ListSource = {
      name,
      kind: "sanctions",
      fetchList: () => Promise.resolve({ version: "v1", contentSha256: createHash("sha256").update(name).digest(), entries }),
    };
    const broken: ListSource = { name: "liste_injoignable", kind: "pep", fetchList: () => Promise.reject(new Error("réseau indisponible")) };
    const job = new AmlListsJob(new ListIngestionService(apiPool, silentLogger), [healthy, broken], silentLogger, 60_000);
    await expect(job.run()).rejects.toThrow("liste_injoignable");
    const current = await owner.query("SELECT 1 FROM aml.list_versions WHERE source = $1 AND is_current", [name]);
    expect(current.rowCount).toBe(1);
  });

  it("n'échoue au rafraîchissement des taux que si aucun fournisseur ne répond", async () => {
    const provider = (id: string): RateProvider => ({ name: id }) as unknown as RateProvider;
    const outcomes = new Map<string, boolean>([["ok", true], ["ko", false]]);
    const ingestion = {
      ingest: (source: { name: string }) => (outcomes.get(source.name) === true ? Promise.resolve({}) : Promise.reject(new Error("panne"))),
    } as unknown as RateIngestionService;
    await expect(new FxRefreshJob(ingestion, [provider("ok"), provider("ko")], silentLogger, 60_000).run()).resolves.toBeUndefined();
    await expect(new FxRefreshJob(ingestion, [provider("ko")], silentLogger, 60_000).run()).rejects.toThrow("aucun fournisseur");
    expect(() => new FxRefreshJob(ingestion, [], silentLogger, 60_000)).toThrow();
  });

  it("délègue la synchronisation KYC, paiements et webhooks avec leurs bornes", async () => {
    const calls: unknown[] = [];
    const kyc = { synchronize: (limit: number) => (calls.push(["kyc", limit]), Promise.resolve({ refreshed: 0, failed: 0, expired: 0 })) } as unknown as KycService;
    const payments = { synchronize: (options: unknown) => (calls.push(["payments", options]), Promise.resolve({})) } as unknown as PaymentOrchestrator;
    const inbox = { processPending: (limit: number) => (calls.push(["webhooks", limit]), Promise.resolve({ processed: 1, failed: 0 })) } as unknown as WebhookInbox;
    await new KycSyncJob(kyc, silentLogger, 60_000, 25).run();
    await new PaymentSyncJob(payments, silentLogger, 60_000, 45, 80).run();
    await new WebhookRetryJob(inbox, silentLogger, 60_000, 10).run();
    expect(calls).toEqual([["kyc", 25], ["payments", { limit: 80, fundingTtlMinutes: 45 }], ["webhooks", 10]]);
  });

  it("purge les clés expirées et expire les demandes de double validation dépassées", async () => {
    const requester = await owner.query<{ id: string }>(
      "INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES ($1, 'Demandeur', 'active', '$argon2id$v=19$test') RETURNING id",
      [`purge-${randomUUID()}@transfertplus.example`],
    );
    const requesterId = requester.rows[0]!.id;
    await owner.query("INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code) VALUES ($1, 'risk_manager')", [requesterId]);
    const payload = JSON.stringify({ reason: "Demande ancienne non traitée" });
    const request = await owner.query<{ id: string }>(
      `INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload, payload_sha256, justification,
                                                requested_by_admin_id, requested_at, expires_at)
       VALUES ('transfers:refund', 'refund_transfer', 'transfer', $1, $2::jsonb, sha256(convert_to($2::jsonb::text, 'UTF8')), 'Justification de test',
               $3, now() - interval '2 days', now() - interval '1 day')
       RETURNING id`,
      [randomUUID(), payload, requesterId],
    );
    await new MaintenanceJob(apiPool, silentLogger, 60_000).run();
    const status = await owner.query<{ status: string }>("SELECT status::text FROM backoffice.approval_requests WHERE id = $1", [request.rows[0]!.id]);
    expect(status.rows[0]?.status).toBe("expired");
  });
});
