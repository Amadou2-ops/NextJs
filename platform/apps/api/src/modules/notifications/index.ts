import type { Logger } from "pino";

import type { AppConfig } from "../../config/env.js";
import type { DatabasePool } from "../../db/pool.js";
import type { FieldEncryptor } from "../../lib/crypto/fieldEncryption.js";
import { smsSenderFromConfig } from "../../lib/sms/smsSender.js";
import type { SmsSender } from "../../lib/sms/smsSender.js";
import { CustomerNotifier } from "./customerNotifier.js";
import { OutboxDispatcher } from "./outboxDispatcher.js";

export function createOutboxDispatcher(params: {
  readonly config: AppConfig;
  readonly pool: DatabasePool;
  readonly logger: Logger;
  readonly encryptor: FieldEncryptor;
  readonly workerId: string;
  readonly sms?: SmsSender;
}): OutboxDispatcher {
  const logger = params.logger.child({ module: "outbox" });
  const notifier = new CustomerNotifier({
    pool: params.pool,
    sms: params.sms ?? smsSenderFromConfig(params.config.auth.sms, logger),
    encryptor: params.encryptor,
    logger,
  });
  return new OutboxDispatcher({ pool: params.pool, logger, notifier, workerId: params.workerId });
}
