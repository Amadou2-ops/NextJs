import type { Logger } from "pino";

import type { RateIngestionService } from "../modules/fx/rateIngestion.service.js";
import type { RateProvider } from "../modules/fx/providers/types.js";
import type { Job } from "./scheduler.js";

/**
 * Rafraîchissement des taux auprès de chaque fournisseur configuré. L'échec
 * d'un fournisseur n'empêche pas la collecte des autres ; la tâche échoue
 * seulement si TOUS ont échoué.
 */
export class FxRefreshJob implements Job {
  readonly name = "fx-refresh";

  constructor(
    private readonly ingestion: RateIngestionService,
    private readonly providers: readonly RateProvider[],
    private readonly logger: Logger,
    readonly intervalMs: number,
  ) {
    if (providers.length === 0) throw new Error("au moins un fournisseur de taux est requis");
  }

  async run(): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((provider) => this.ingestion.ingest(provider)));
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    this.logger.info({ succeeded, total: this.providers.length }, "taux de change rafraîchis");
    if (succeeded === 0) throw new Error("aucun fournisseur de taux n'a répondu");
  }
}
