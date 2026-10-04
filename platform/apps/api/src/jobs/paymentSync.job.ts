import type { Logger } from "pino";

import type { PaymentOrchestrator } from "../modules/transfers/payment.orchestrator.js";
import type { Job } from "./scheduler.js";

/**
 * Filet de sécurité des paiements : relit les tentatives restées ouvertes
 * (webhook perdu), annule les financements expirés, relance les paiements
 * sortants et remboursements en attente (processus API arrêté, prestataire
 * indisponible, trésorerie réapprovisionnée).
 */
export class PaymentSyncJob implements Job {
  readonly name = "payment-sync";

  constructor(
    private readonly orchestrator: PaymentOrchestrator,
    private readonly logger: Logger,
    readonly intervalMs: number,
    private readonly fundingTtlMinutes: number,
    private readonly batchSize = 100,
  ) {}

  async run(): Promise<void> {
    const result = await this.orchestrator.synchronize({ limit: this.batchSize, fundingTtlMinutes: this.fundingTtlMinutes });
    this.logger.info(result, "synchronisation des paiements terminée");
  }
}
