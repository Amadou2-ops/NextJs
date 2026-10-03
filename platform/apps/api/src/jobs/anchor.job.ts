import type { Logger } from "pino";

import type { DatabasePool } from "../db/pool.js";
import type { TimestampAuthorityClient } from "../lib/crypto/rfc3161.js";
import type { Job } from "./scheduler.js";

/**
 * Ancrage externe de la chaîne d'empreintes du registre.
 *
 * Seul un état VÉRIFIÉ est ancré : le journal retenu est le plus récent
 * couvert par un rapprochement sain (jamais une tête non contrôlée, qui
 * pourrait déjà être altérée). Son empreinte est horodatée par une autorité
 * RFC 3161 indépendante ; le jeton vérifié est conservé comme preuve dans
 * ledger.chain_anchors. Vérification hors ligne par un auditeur :
 *   openssl ts -verify -in jeton.der -token_in -digest <empreinte hex> -CAfile ca.pem
 */

export interface AnchorResult {
  readonly status: "anchored" | "nothing_to_anchor" | "already_anchored";
  readonly seq?: bigint;
}

export class ChainAnchorJob implements Job {
  readonly name = "ledger-chain-anchor";

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
    private readonly tsa: TimestampAuthorityClient,
    private readonly target: string,
    readonly intervalMs: number,
  ) {
    if (!/^[a-z0-9_-]{2,50}$/.test(target)) throw new Error(`cible d'ancrage invalide : ${target}`);
  }

  async run(): Promise<void> {
    await this.anchor();
  }

  async anchor(): Promise<AnchorResult> {
    const candidate = await this.pool.query<{ seq: bigint; hash: Buffer }>(
      `SELECT j.seq, j.hash
         FROM ledger.journals j
        WHERE j.seq = (SELECT max(verified_to_seq) FROM ledger.reconciliation_runs WHERE status = 'healthy')`,
    );
    const journal = candidate.rows[0];
    if (journal === undefined) return { status: "nothing_to_anchor" };

    const existing = await this.pool.query("SELECT 1 FROM ledger.chain_anchors WHERE anchor_target = $1 AND seq >= $2", [this.target, journal.seq.toString()]);
    if (existing.rowCount !== 0) return { status: "already_anchored", seq: journal.seq };

    const stamp = await this.tsa.timestamp(journal.hash);
    await this.pool.query(
      `INSERT INTO ledger.chain_anchors (seq, hash, anchor_target, external_reference, evidence, evidence_type)
       VALUES ($1, $2, $3, $4, $5, 'rfc3161_timestamp_token')`,
      [journal.seq.toString(), journal.hash, this.target, `serial=${stamp.serialNumber};genTime=${stamp.genTime.toISOString()};policy=${stamp.policy}`, stamp.token],
    );
    this.logger.info({ seq: journal.seq.toString(), target: this.target, genTime: stamp.genTime.toISOString() }, "chaîne du registre ancrée");
    return { status: "anchored", seq: journal.seq };
  }
}
