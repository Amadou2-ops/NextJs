import { Gauge } from "prom-client";
import type { Registry } from "prom-client";

import type { Queryable } from "../db/transaction.js";

/**
 * Indicateurs d'exploitation lus en base à chaque collecte. Exposés par le
 * worker seul (une instance) : les répliques de l'API ne dupliquent pas ces
 * séries. Requêtes courtes, sur index, en lecture seule ; une requête en
 * échec fait échouer la collecte entière (cible « down » côté Prometheus)
 * plutôt que de publier des valeurs fausses.
 *
 * Les événements datés sont publiés en horodatage Unix (secondes), 0 quand
 * l'événement n'a jamais eu lieu (aucun rapprochement, aucun ancrage…) : la
 * règle de fraîcheur `time() - x > seuil` couvre ainsi aussi le « jamais ».
 */

const OPEN_TRANSFER_STATUSES = ["awaiting_funding", "funding_processing", "funded", "compliance_review", "payout_pending", "payout_processing", "payout_failed", "refund_pending"] as const;
const WEBHOOK_SOURCES = ["stripe", "flutterwave", "thunes", "smile_id", "onfido"] as const;
const WEBHOOK_BACKLOG_STATUSES = ["received", "processing", "failed"] as const;
const OUTBOX_BACKLOG_STATUSES = ["pending", "processing", "failed", "dead"] as const;
/** Types d'événements surveillés par les règles d'alerte : série à 0 dès le départ, sans quoi `increase()` manquerait la première occurrence. */
const ALERTED_EVENT_TYPES = ["ledger.integrity_breach", "integrations.webhook_exhausted", "fx.rate_rejected", "aml.list_rejected"] as const;

type Row = Readonly<Record<string, unknown>>;

function numberOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`colonne ${key} attendue en texte`);
  return value;
}

export function registerOperationalMetrics(registry: Registry, db: Queryable): void {
  const query = async (sql: string): Promise<readonly Row[]> => (await db.query<Row>(sql)).rows;

  /** Horodatage Unix d'un événement ; 0 s'il n'a jamais eu lieu (l'alerte de fraîcheur se déclenche alors). */
  const timestampGauge = (name: string, help: string, sql: string): void => {
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        const [row] = await query(sql);
        const ts = numberOf(row?.["ts"]);
        this.set(Number.isNaN(ts) ? 0 : ts);
      },
    });
  };

  new Gauge({
    name: "transfertplus_ledger_reconciliation_healthy",
    help: "1 si le dernier rapprochement terminé du registre est sain, 0 sinon ou si aucun n'a abouti.",
    registers: [registry],
    async collect() {
      const [row] = await query("SELECT status FROM ledger.reconciliation_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1");
      this.set(row !== undefined && text(row, "status") === "healthy" ? 1 : 0);
    },
  });

  timestampGauge(
    "transfertplus_ledger_reconciliation_last_finished_timestamp_seconds",
    "Fin du dernier rapprochement du registre (0 : jamais).",
    "SELECT extract(epoch FROM max(finished_at)) AS ts FROM ledger.reconciliation_runs WHERE finished_at IS NOT NULL",
  );
  timestampGauge(
    "transfertplus_ledger_last_anchor_timestamp_seconds",
    "Dernier ancrage externe (RFC 3161) de la chaîne du registre (0 : jamais).",
    "SELECT extract(epoch FROM max(anchored_at)) AS ts FROM ledger.chain_anchors",
  );

  new Gauge({
    name: "transfertplus_aml_sanctions_lists_current",
    help: "Nombre de listes de sanctions courantes importées (OFAC, ONU…).",
    registers: [registry],
    async collect() {
      const [row] = await query("SELECT count(*) AS count FROM aml.list_versions WHERE is_current AND kind = 'sanctions'");
      this.set(numberOf(row?.["count"]));
    },
  });

  timestampGauge(
    "transfertplus_aml_sanctions_lists_oldest_import_timestamp_seconds",
    "Import de la plus ancienne liste de sanctions courante (le criblage la refuse au-delà de sa fraîcheur maximale ; 0 : aucune).",
    "SELECT extract(epoch FROM min(imported_at)) AS ts FROM aml.list_versions WHERE is_current AND kind = 'sanctions'",
  );
  timestampGauge(
    "transfertplus_fx_rates_last_timestamp_seconds",
    "Horodatage fournisseur du taux de change le plus récent (les devis sont refusés au-delà de la fraîcheur configurée ; 0 : aucun).",
    "SELECT extract(epoch FROM max(provider_timestamp)) AS ts FROM fx.rate_snapshots",
  );

  new Gauge({
    name: "transfertplus_webhook_events",
    help: "Événements de webhook non traités, par prestataire et statut.",
    labelNames: ["source", "status"],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await query(
        `SELECT source::text AS source, status::text AS status, count(*) AS count
           FROM integrations.webhook_events WHERE status IN ('received', 'processing', 'failed') GROUP BY 1, 2`,
      );
      // Zéro explicite pour chaque couple : une alerte « > 0 » doit aussi pouvoir se résoudre.
      for (const source of WEBHOOK_SOURCES) {
        for (const status of WEBHOOK_BACKLOG_STATUSES) {
          const row = rows.find((candidate) => candidate["source"] === source && candidate["status"] === status);
          this.set({ source, status }, numberOf(row?.["count"] ?? 0));
        }
      }
    },
  });

  new Gauge({
    name: "transfertplus_webhook_backlog_oldest_age_seconds",
    help: "Âge du plus ancien événement de webhook en attente de traitement (0 : aucun).",
    registers: [registry],
    async collect() {
      const [row] = await query(
        "SELECT COALESCE(extract(epoch FROM now() - min(received_at)), 0) AS age FROM integrations.webhook_events WHERE status IN ('received', 'failed')",
      );
      this.set(numberOf(row?.["age"]));
    },
  });

  new Gauge({
    name: "transfertplus_webhook_rejections_total",
    help: "Webhooks refusés depuis l'origine (signature absente ou fausse, hors délai, source inconnue…), par prestataire et motif.",
    labelNames: ["source", "reason"],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await query("SELECT source, reason::text AS reason, count(*) AS count FROM integrations.webhook_rejections GROUP BY 1, 2");
      for (const row of rows) this.set({ source: text(row, "source"), reason: text(row, "reason") }, numberOf(row["count"]));
    },
  });

  new Gauge({
    name: "transfertplus_outbox_events",
    help: "Événements de l'outbox non publiés, par statut (dead : abandonnés après le nombre maximal d'essais).",
    labelNames: ["status"],
    registers: [registry],
    async collect() {
      const rows = await query("SELECT status::text AS status, count(*) AS count FROM integrations.outbox WHERE status <> 'published' GROUP BY 1");
      for (const status of OUTBOX_BACKLOG_STATUSES) {
        this.set({ status }, numberOf(rows.find((row) => row["status"] === status)?.["count"] ?? 0));
      }
    },
  });

  new Gauge({
    name: "transfertplus_outbox_events_total",
    help: "Événements émis depuis l'origine, par type (ledger.integrity_breach, integrations.webhook_exhausted, fx.rate_rejected, aml.list_rejected…) ; croissant.",
    labelNames: ["event_type"],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await query("SELECT event_type, count(*) AS count FROM integrations.outbox GROUP BY 1");
      for (const eventType of ALERTED_EVENT_TYPES) this.set({ event_type: eventType }, 0);
      for (const row of rows) this.set({ event_type: text(row, "event_type") }, numberOf(row["count"]));
    },
  });

  new Gauge({
    name: "transfertplus_transfers_open",
    help: "Transferts non terminés, par statut.",
    labelNames: ["status"],
    registers: [registry],
    async collect() {
      const rows = await query(
        `SELECT status::text AS status, count(*) AS count FROM transfers.transfers
          WHERE status IN ('awaiting_funding', 'funding_processing', 'funded', 'compliance_review', 'payout_pending', 'payout_processing', 'payout_failed', 'refund_pending')
          GROUP BY 1`,
      );
      for (const status of OPEN_TRANSFER_STATUSES) {
        this.set({ status }, numberOf(rows.find((row) => row["status"] === status)?.["count"] ?? 0));
      }
    },
  });

  new Gauge({
    name: "transfertplus_transfers_oldest_age_seconds",
    help: "Ancienneté du plus ancien transfert dans un statut d'attente (depuis son dernier changement d'état ; 0 : aucun).",
    labelNames: ["status"],
    registers: [registry],
    async collect() {
      const rows = await query(
        `SELECT status::text AS status, extract(epoch FROM now() - min(updated_at)) AS age FROM transfers.transfers
          WHERE status IN ('awaiting_funding', 'funding_processing', 'funded', 'compliance_review', 'payout_pending', 'payout_processing', 'payout_failed', 'refund_pending')
          GROUP BY 1`,
      );
      for (const status of OPEN_TRANSFER_STATUSES) {
        this.set({ status }, numberOf(rows.find((row) => row["status"] === status)?.["age"] ?? 0));
      }
    },
  });

  new Gauge({
    name: "transfertplus_aml_alerts_open",
    help: "Alertes LCB-FT non clôturées, par gravité et caractère bloquant.",
    labelNames: ["severity", "blocking"],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await query(
        `SELECT a.severity::text AS severity, r.blocks_transfer::text AS blocking, count(*) AS count
           FROM aml.alerts a JOIN aml.rules r ON r.code = a.rule_code
          WHERE a.status NOT IN ('closed_false_positive', 'closed_confirmed')
          GROUP BY 1, 2`,
      );
      for (const severity of ["low", "medium", "high", "critical"]) {
        for (const blocking of ["true", "false"]) {
          const row = rows.find((candidate) => candidate["severity"] === severity && candidate["blocking"] === blocking);
          this.set({ severity, blocking }, numberOf(row?.["count"] ?? 0));
        }
      }
    },
  });

  new Gauge({
    name: "transfertplus_payment_circuit_open",
    help: "1 si le disjoncteur d'un prestataire de paiement est ouvert ou en sonde, 0 s'il est fermé.",
    labelNames: ["provider"],
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await query("SELECT provider::text AS provider, circuit_state::text AS state FROM payments.provider_health");
      for (const row of rows) this.set({ provider: text(row, "provider") }, text(row, "state") === "closed" ? 0 : 1);
    },
  });
}
