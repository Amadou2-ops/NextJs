import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import express from "express";
import { Gauge, Registry } from "prom-client";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config/env.js";
import { JobScheduler } from "../src/jobs/scheduler.js";
import { createMetricsRegistry, httpMetrics, jobMetrics, startMetricsServer, statusClass } from "../src/observability/metrics.js";
import { registerOperationalMetrics } from "../src/observability/operationalMetrics.js";
import { buildTestConfig, createApiPool, createOwnerPool, createTestKeys, silentLogger } from "./support/fixtures.js";

/**
 * Métriques Prometheus : étiquettes à cardinalité bornée (motif de route,
 * jamais l'URL reçue), observation des tâches planifiées, indicateurs lus en
 * base par le worker et serveur interne dédié.
 */

const keys = await createTestKeys();
const config = buildTestConfig(keys);
const owner = createOwnerPool();
const apiPool = createApiPool(config);
afterAll(async () => {
  await apiPool.end();
  await owner.end();
});

/** Valeur d'une série (histogrammes : `<nom>_count`, `<nom>_sum`, `<nom>_bucket`). */
async function sampleValue(registry: Registry, name: string, labels: Readonly<Record<string, string>> = {}): Promise<number | undefined> {
  const base = name.replace(/_(count|sum|bucket)$/, "");
  const metric = await (registry.getSingleMetric(name) ?? registry.getSingleMetric(base))?.get();
  const sample = metric?.values.find(
    (candidate) => ((candidate as { metricName?: string }).metricName ?? metric.name) === name && Object.entries(labels).every(([key, value]) => candidate.labels[key] === value),
  );
  return sample?.value;
}

describe("métriques HTTP", () => {
  it("étiquette par motif de route et classe de statut, jamais par l'URL reçue", async () => {
    const registry = createMetricsRegistry("api", "1.2.3-test");
    const app = express();
    app.use(httpMetrics(registry));
    const router = express.Router();
    router.get("/transfers/:transferId", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use("/v1", router);
    app.use((_req, res) => {
      res.status(404).end();
    });

    const transferId = randomUUID();
    await request(app).get(`/v1/transfers/${transferId}`).expect(200);
    await request(app).get(`/inconnu/${transferId}`).expect(404);

    const exposition = await registry.metrics();
    expect(exposition).toContain('route="/v1/transfers/:transferId"');
    expect(exposition).toContain('route="unmatched"');
    expect(exposition).toContain('status_class="2xx"');
    expect(exposition).toContain('status_class="4xx"');
    expect(exposition).not.toContain(transferId);
    expect(exposition).toContain('transfertplus_build_info{version="1.2.3-test",service="api"} 1');
    expect(exposition).toContain("transfertplus_process_cpu_seconds_total");
  });

  it("regroupe les statuts par classe", () => {
    expect(statusClass(201)).toBe("2xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe("other");
    expect(statusClass(600)).toBe("other");
  });
});

describe("métriques des tâches planifiées", () => {
  it("compte les exécutions par issue et horodate le dernier succès", async () => {
    const registry = new Registry();
    const observer = jobMetrics(registry, [
      { name: "ok_job", intervalMs: 60_000 },
      { name: "failing_job", intervalMs: 90_000 },
    ]);
    expect(await sampleValue(registry, "transfertplus_job_last_success_timestamp_seconds", { task: "failing_job" })).toBe(0);
    expect(await sampleValue(registry, "transfertplus_job_runs_total", { task: "failing_job", outcome: "failed" })).toBe(0);
    expect(await sampleValue(registry, "transfertplus_job_interval_seconds", { task: "failing_job" })).toBe(90);

    const scheduler = new JobScheduler(
      apiPool,
      silentLogger,
      [
        { name: `ok_job`, intervalMs: 60_000, run: () => Promise.resolve() },
        { name: `failing_job`, intervalMs: 60_000, run: () => Promise.reject(new Error("panne simulée")) },
      ],
      observer,
    );
    const before = Date.now() / 1000;
    expect(await scheduler.runOnce("ok_job")).toBe("completed");
    expect(await scheduler.runOnce("failing_job")).toBe("failed");
    await scheduler.stop();

    expect(await sampleValue(registry, "transfertplus_job_runs_total", { task: "ok_job", outcome: "completed" })).toBe(1);
    expect(await sampleValue(registry, "transfertplus_job_runs_total", { task: "failing_job", outcome: "failed" })).toBe(1);
    expect(await sampleValue(registry, "transfertplus_job_last_success_timestamp_seconds", { task: "ok_job" })).toBeGreaterThanOrEqual(before - 1);
    expect(await sampleValue(registry, "transfertplus_job_last_success_timestamp_seconds", { task: "failing_job" })).toBe(0);
    expect(await sampleValue(registry, "transfertplus_job_duration_seconds_count", { task: "failing_job" })).toBe(1);
  });

  it("ne mesure pas la durée d'une exécution sautée", async () => {
    const registry = new Registry();
    const observer = jobMetrics(registry, [{ name: "verrouillee", intervalMs: 60_000 }]);
    observer.observe("verrouillee", "skipped_locked", 0.001);
    expect(await sampleValue(registry, "transfertplus_job_runs_total", { task: "verrouillee", outcome: "skipped_locked" })).toBe(1);
    expect(await sampleValue(registry, "transfertplus_job_duration_seconds_count", { task: "verrouillee" })).toBeUndefined();
  });
});

describe("indicateurs d'exploitation lus en base", () => {
  it("publie l'état du registre, des webhooks, de l'outbox, des transferts et de la conformité", async () => {
    const registry = new Registry();
    registerOperationalMetrics(registry, apiPool);
    const exposition = await registry.metrics();
    for (const name of [
      "transfertplus_aml_sanctions_lists_current",
      "transfertplus_webhook_backlog_oldest_age_seconds",
      "transfertplus_outbox_events",
      "transfertplus_transfers_open",
      "transfertplus_transfers_oldest_age_seconds",
      "transfertplus_aml_alerts_open",
    ]) {
      expect(exposition).toMatch(new RegExp(`^${name}(\\{[^}]*\\})? \\d`, "m"));
    }
    // Zéro explicite pour chaque couple prestataire / statut.
    expect(await sampleValue(registry, "transfertplus_webhook_events", { source: "onfido", status: "failed" })).toBeTypeOf("number");
    expect(await sampleValue(registry, "transfertplus_outbox_events", { status: "dead" })).toBeTypeOf("number");
    // Types d'événements alertés présents même avant leur première occurrence.
    for (const eventType of ["ledger.integrity_breach", "integrations.webhook_exhausted", "fx.rate_rejected", "aml.list_rejected"]) {
      expect(await sampleValue(registry, "transfertplus_outbox_events_total", { event_type: eventType })).toBeTypeOf("number");
    }
    expect(await sampleValue(registry, "transfertplus_transfers_open", { status: "payout_failed" })).toBeTypeOf("number");
    expect(await sampleValue(registry, "transfertplus_aml_alerts_open", { severity: "critical", blocking: "true" })).toBeTypeOf("number");
  });

  it("suit chaque webhook refusé par prestataire et motif", async () => {
    const registry = new Registry();
    registerOperationalMetrics(registry, apiPool);
    const labels = { source: "stripe", reason: "invalid_signature" };
    const before = (await sampleValue(registry, "transfertplus_webhook_rejections_total", labels)) ?? 0;
    await owner.query(
      "INSERT INTO integrations.webhook_rejections (source, reason, body_sha256, body_size) VALUES ('stripe', 'invalid_signature', $1, 12)",
      [createHash("sha256").update(randomUUID()).digest()],
    );
    expect(await sampleValue(registry, "transfertplus_webhook_rejections_total", labels)).toBe(before + 1);
  });

  it("publie l'état du dernier rapprochement et l'âge des listes courantes", async () => {
    const registry = new Registry();
    registerOperationalMetrics(registry, apiPool);
    const source = `metriques_${randomUUID().slice(0, 8)}`;
    await owner.query(
      `INSERT INTO aml.list_versions (source, kind, version, content_sha256, entry_count, is_current)
       VALUES ($1, 'sanctions', 'v1', $2, 1, true)`,
      [source, createHash("sha256").update(source).digest()],
    );
    expect(await sampleValue(registry, "transfertplus_aml_sanctions_lists_current")).toBeGreaterThanOrEqual(1);
    const oldest = await sampleValue(registry, "transfertplus_aml_sanctions_lists_oldest_import_timestamp_seconds");
    expect(oldest).toBeGreaterThan(0);
    expect(oldest).toBeLessThanOrEqual(Date.now() / 1000 + 1);
    const [run] = (await owner.query<{ status: string }>("SELECT status FROM ledger.reconciliation_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1")).rows;
    expect(await sampleValue(registry, "transfertplus_ledger_reconciliation_healthy")).toBe(run?.status === "healthy" ? 1 : 0);
    const finished = await sampleValue(registry, "transfertplus_ledger_reconciliation_last_finished_timestamp_seconds");
    if (run === undefined) expect(finished).toBe(0);
    else expect(finished).toBeGreaterThan(0);
  });

  it("fait échouer la collecte entière quand la base ne répond pas", async () => {
    const registry = new Registry();
    registerOperationalMetrics(registry, { query: () => Promise.reject(new Error("base indisponible")) });
    await expect(registry.metrics()).rejects.toThrow("base indisponible");
  });
});

describe("serveur interne de métriques", () => {
  it("sert GET /metrics seulement, et 503 si la collecte échoue", async () => {
    const registry = createMetricsRegistry("worker", "1.2.3-test");
    let failing = false;
    new Gauge({
      name: "transfertplus_test_collect",
      help: "Collecte de test.",
      registers: [registry],
      collect() {
        if (failing) throw new Error("collecte en échec");
        this.set(1);
      },
    });
    const errors: unknown[] = [];
    const server = await startMetricsServer(registry, { host: "127.0.0.1", port: 0 }, (error) => errors.push(error));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
      const ok = await fetch(`${base}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe(registry.contentType);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.text()).toContain('transfertplus_test_collect{service="worker"} 1');

      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${base}/metrics?format=json`)).status).toBe(404);

      failing = true;
      const unavailable = await fetch(`${base}/metrics`);
      expect(unavailable.status).toBe(503);
      expect(errors).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuse un port déjà occupé", async () => {
    const registry = new Registry();
    const first = await startMetricsServer(registry, { host: "127.0.0.1", port: 0 }, () => undefined);
    try {
      const port = (first.address() as AddressInfo).port;
      await expect(startMetricsServer(registry, { host: "127.0.0.1", port }, () => undefined)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
    }
  });
});

describe("configuration des métriques", () => {
  it("désactivées sans METRICS_PORT, locales par défaut, jamais sur le port public", () => {
    expect(config.metrics).toBeUndefined();
    expect(buildTestConfig(keys, { METRICS_PORT: "9464" }).metrics).toEqual({ host: "127.0.0.1", port: 9464 });
    expect(buildTestConfig(keys, { METRICS_PORT: "9464", METRICS_HOST: "0.0.0.0" }).metrics).toEqual({ host: "0.0.0.0", port: 9464 });
    expect(() => buildTestConfig(keys, { METRICS_PORT: "8080", PORT: "8080" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ METRICS_PORT: "70000" })).toThrow(ConfigurationError);
  });
});
