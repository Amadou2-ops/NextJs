import type { Logger } from "pino";

import type { ListIngestionService } from "../modules/aml/listIngestion.service.js";
import type { ListSource } from "../modules/aml/lists/sources.js";
import type { Job } from "./scheduler.js";

/**
 * Mise à jour des listes de criblage. L'échec d'une source n'empêche pas
 * les autres ; la tâche échoue si au moins une source a échoué (alerte
 * d'exploitation : au-delà de AML_LISTS_MAX_AGE_HOURS, tout transfert part
 * en revue manuelle).
 */
export class AmlListsJob implements Job {
  readonly name = "aml-lists";

  constructor(
    private readonly ingestion: ListIngestionService,
    private readonly sources: readonly ListSource[],
    private readonly logger: Logger,
    readonly intervalMs: number,
  ) {}

  async run(): Promise<void> {
    const results = await Promise.allSettled(this.sources.map((source) => this.ingestion.refresh(source)));
    const failures = results
      .map((result, index) => ({ result, source: this.sources[index]?.name ?? "inconnue" }))
      .filter((entry) => entry.result.status === "rejected");
    for (const failure of failures) {
      this.logger.error({ source: failure.source, err: (failure.result as PromiseRejectedResult).reason }, "mise à jour de liste de criblage en échec");
    }
    if (failures.length > 0) throw new Error(`listes non mises à jour : ${failures.map((failure) => failure.source).join(", ")}`);
  }
}
