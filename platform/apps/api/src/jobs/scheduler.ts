import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { DatabasePool } from "../db/pool.js";

/**
 * Planificateur de tâches de fond.
 *
 * Plusieurs instances du worker peuvent tourner (haute disponibilité) : un
 * verrou consultatif PostgreSQL (pg_try_advisory_lock) garantit qu'une même
 * tâche ne s'exécute jamais en parallèle sur deux instances. Dans une instance,
 * une tâche ne démarre pas tant que l'exécution précédente n'est pas finie.
 */

export interface Job {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export type JobOutcome = "completed" | "skipped_locked" | "skipped_running" | "failed";

function lockKey(name: string): string {
  // Clé 64 bits signée stable dérivée du nom de la tâche.
  return BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(`job:${name}`).digest("hex").slice(0, 16)}`)).toString();
}

export class JobScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<JobOutcome>>();
  private stopped = false;

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    private readonly jobs: readonly Job[],
  ) {
    const names = new Set(jobs.map((job) => job.name));
    if (names.size !== jobs.length) throw new Error("noms de tâches dupliqués");
  }

  start(): void {
    for (const job of this.jobs) {
      const timer = setInterval(() => {
        void this.runOnce(job.name);
      }, job.intervalMs);
      timer.unref();
      this.timers.set(job.name, timer);
      void this.runOnce(job.name);
    }
  }

  /** Exécute une tâche immédiatement (si elle n'est pas déjà en cours ailleurs). */
  async runOnce(name: string): Promise<JobOutcome> {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (job === undefined) throw new Error(`tâche inconnue : ${name}`);
    if (this.stopped) return "skipped_running";
    const inFlight = this.running.get(name);
    if (inFlight !== undefined) return "skipped_running";
    const execution = this.execute(job).finally(() => {
      this.running.delete(name);
    });
    this.running.set(name, execution);
    return execution;
  }

  private async execute(job: Job): Promise<JobOutcome> {
    const client = await this.pool.connect();
    const key = lockKey(job.name);
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]);
      locked = result.rows[0]?.locked === true;
      if (!locked) return "skipped_locked";
      const startedAt = performance.now();
      await job.run();
      this.logger.info({ job: job.name, durationMs: Math.round(performance.now() - startedAt) }, "tâche terminée");
      return "completed";
    } catch (error: unknown) {
      this.logger.error({ job: job.name, err: error }, "échec de la tâche");
      return "failed";
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]).catch(() => undefined);
      client.release();
    }
  }

  /** Arrêt propre : plus de nouveaux lancements, attente des exécutions en cours. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running.values()]);
  }
}
