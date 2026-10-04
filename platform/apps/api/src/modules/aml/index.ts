import type { Logger } from "pino";

import type { AppConfig } from "../../config/env.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { ComplianceService } from "./compliance.service.js";
import { OfacSdnSource, OpenSanctionsPepSource, UnConsolidatedSource } from "./lists/sources.js";
import type { ListSource } from "./lists/sources.js";
import { ScreeningService } from "./screening.service.js";

export function createComplianceService(config: AppConfig, encryptor: FieldEncryptor, logger: Logger): ComplianceService {
  return new ComplianceService({
    screening: new ScreeningService({ matchThreshold: config.aml.matchThreshold, maxListAgeHours: config.aml.listsMaxAgeHours }),
    encryptor,
    logger,
  });
}

/** Listes officielles (OFAC SDN, ONU) et, si une licence est configurée, PPE OpenSanctions. */
export function configuredListSources(config: AppConfig, fetchImpl: typeof fetch = fetch): readonly ListSource[] {
  const sources: ListSource[] = [
    new OfacSdnSource({ sdn: config.aml.ofacSdnUrl, alt: config.aml.ofacAltUrl }, fetchImpl),
    new UnConsolidatedSource(config.aml.unListUrl, fetchImpl),
  ];
  const pep = config.aml.openSanctionsPep;
  if (pep !== undefined) sources.push(new OpenSanctionsPepSource(pep.url, pep.apiKey, fetchImpl));
  return sources;
}
