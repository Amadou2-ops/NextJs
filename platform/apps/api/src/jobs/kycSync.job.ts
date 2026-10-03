import type { Logger } from "pino";

import type { KycService } from "../modules/kyc/kyc.service.js";
import type { Job } from "./scheduler.js";

/**
 * Filet de sécurité KYC : relit chez le prestataire les vérifications dont
 * le webhook a pu être perdu, expire les sessions abandonnées et les
 * approbations échues (le niveau du client est recalculé par la base).
 */
export class KycSyncJob implements Job {
  readonly name = "kyc-sync";

  constructor(
    private readonly kyc: KycService,
    private readonly logger: Logger,
    readonly intervalMs: number,
    private readonly batchSize = 50,
  ) {}

  async run(): Promise<void> {
    const result = await this.kyc.synchronize(this.batchSize);
    this.logger.info(result, "synchronisation KYC terminée");
  }
}
