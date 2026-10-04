import { createServer } from "node:http";
import type { Server } from "node:http";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Métriques Prometheus (préfixe `transfertplus_`).
 *
 * Exposées sur un port INTERNE distinct (METRICS_PORT), jamais par le
 * serveur public : Caddy ne route pas ce port et Prometheus le lit sur le
 * réseau interne de la pile. Aucune étiquette ne porte de donnée
 * personnelle ni de valeur choisie par l'appelant : la route est le MOTIF
 * Express (`/v1/transfers/:transferId`), jamais l'URL reçue, et une requête
 * sans route connue est comptée sous « unmatched » (cardinalité bornée).
 */

export type MetricsService = "api" | "worker";

export function createMetricsRegistry(service: MetricsService, version: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: "transfertplus_" });
  new Gauge({
    name: "transfertplus_build_info",
    help: "Version déployée (valeur constante 1).",
    labelNames: ["version"],
    registers: [registry],
  }).set({ version }, 1);
  return registry;
}

/** Statut HTTP regroupé par classe (2xx, 4xx…) : cardinalité bornée. */
export function statusClass(status: number): string {
  return status >= 100 && status <= 599 ? `${Math.floor(status / 100).toString()}xx` : "other";
}

/** Motif de route Express de la requête traitée, ou « unmatched ». */
export function routePattern(req: Request): string {
  const route: unknown = (req as { route?: { path?: unknown } }).route?.path;
  if (typeof route !== "string") return "unmatched";
  return `${req.baseUrl}${route}`;
}

export function httpMetrics(registry: Registry): RequestHandler {
  const duration = new Histogram({
    name: "transfertplus_http_request_duration_seconds",
    help: "Durée des requêtes HTTP de l'API, par méthode, motif de route et classe de statut.",
    labelNames: ["method", "route", "status_class"],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    const end = duration.startTimer();
    res.on("finish", () => {
      end({ method: req.method, route: routePattern(req), status_class: statusClass(res.statusCode) });
    });
    next();
  };
}

/**
 * Observateur des tâches planifiées du worker (exécutions, durées, dernier
 * succès). Étiquette `task`, et non `job` : celle-ci est réservée par
 * Prometheus au nom de la cible.
 */
export interface JobObserver {
  observe(task: string, outcome: "completed" | "failed" | "skipped_locked" | "skipped_running", durationSeconds: number): void;
}

export function jobMetrics(registry: Registry, jobs: readonly { readonly name: string; readonly intervalMs: number }[]): JobObserver {
  const runs = new Counter({
    name: "transfertplus_job_runs_total",
    help: "Exécutions des tâches planifiées, par issue.",
    labelNames: ["task", "outcome"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "transfertplus_job_duration_seconds",
    help: "Durée des exécutions des tâches planifiées (terminées ou en échec).",
    labelNames: ["task"],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
    registers: [registry],
  });
  const lastSuccess = new Gauge({
    name: "transfertplus_job_last_success_timestamp_seconds",
    help: "Horodatage Unix de la dernière exécution réussie d'une tâche (0 : jamais depuis le démarrage).",
    labelNames: ["task"],
    registers: [registry],
  });
  const interval = new Gauge({
    name: "transfertplus_job_interval_seconds",
    help: "Période configurée de chaque tâche (référence des alertes de fraîcheur).",
    labelNames: ["task"],
    registers: [registry],
  });
  // Séries présentes dès le démarrage : une tâche qui n'a jamais réussi se voit.
  for (const { name: task, intervalMs } of jobs) {
    interval.set({ task }, intervalMs / 1000);
    lastSuccess.set({ task }, 0);
    for (const outcome of ["completed", "failed"]) runs.inc({ task, outcome }, 0);
  }
  return {
    observe(task, outcome, durationSeconds) {
      runs.inc({ task, outcome });
      if (outcome === "completed" || outcome === "failed") duration.observe({ task }, durationSeconds);
      if (outcome === "completed") lastSuccess.set({ task }, Date.now() / 1000);
    },
  };
}

/**
 * Serveur interne de métriques : GET /metrics seulement. Une collecte en
 * échec (base indisponible) renvoie 503 : Prometheus enregistre la cible
 * comme en panne au lieu de séries silencieusement absentes.
 */
export function startMetricsServer(registry: Registry, options: { readonly host: string; readonly port: number }, onError: (error: unknown) => void): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        response.writeHead(200, { "Content-Type": registry.contentType, "Cache-Control": "no-store" }).end(body);
      })
      .catch((error: unknown) => {
        onError(error);
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("collecte des métriques indisponible\n");
      });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
