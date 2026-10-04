-- =============================================================================
-- 0018 — Registre : historique des rapprochements et preuves d'ancrage
--
-- reconciliation_runs : chaque exécution du contrôle d'intégrité (chaîne
--   d'empreintes, soldes, balance générale, audit) est tracée avec son
--   périmètre et ses anomalies. La vérification de la chaîne est
--   incrémentale (reprise au dernier seq vérifié sain), complétée au moins
--   une fois par 24 heures par une vérification complète depuis le seq 1 :
--   une altération d'un journal ancien sans effet sur les soldes (libellé,
--   métadonnées) est ainsi détectée.
-- chain_anchors.evidence : jeton d'horodatage RFC 3161 (ou autre preuve
--   externe) prouvant que l'empreinte de tête existait à une date donnée.
-- =============================================================================

CREATE TABLE ledger.reconciliation_runs (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at         timestamptz,
    status              text        NOT NULL DEFAULT 'running',
    scope               text        NOT NULL DEFAULT 'incremental',
    -- Intervalle de seq dont la chaîne a été recalculée.
    verified_from_seq   bigint,
    verified_to_seq     bigint,
    chain_head_seq      bigint,
    chain_head_hash     bytea,
    balances_checked    integer,
    problems            jsonb       NOT NULL DEFAULT '[]'::jsonb,
    error_message       text,
    worker_id           text        NOT NULL,
    CONSTRAINT reconciliation_status CHECK (status IN ('running', 'healthy', 'anomalies', 'error')),
    CONSTRAINT reconciliation_scope CHECK (scope IN ('incremental', 'full')),
    CONSTRAINT reconciliation_full_from_start CHECK (scope <> 'full' OR verified_from_seq IS NULL OR verified_from_seq = 1),
    CONSTRAINT reconciliation_finished CHECK ((status = 'running') = (finished_at IS NULL)),
    CONSTRAINT reconciliation_problems_array CHECK (jsonb_typeof(problems) = 'array'),
    CONSTRAINT reconciliation_anomalies_listed CHECK (status <> 'anomalies' OR jsonb_array_length(problems) > 0),
    CONSTRAINT reconciliation_healthy_clean CHECK (status <> 'healthy' OR jsonb_array_length(problems) = 0),
    CONSTRAINT reconciliation_error_message CHECK ((status = 'error') = (error_message IS NOT NULL)),
    CONSTRAINT reconciliation_range CHECK (
        verified_from_seq IS NULL OR (verified_to_seq IS NOT NULL AND verified_to_seq >= verified_from_seq - 1)
    ),
    CONSTRAINT reconciliation_hash_len CHECK (chain_head_hash IS NULL OR octet_length(chain_head_hash) = 32)
);

CREATE INDEX reconciliation_runs_latest_idx ON ledger.reconciliation_runs (started_at DESC);
CREATE INDEX reconciliation_runs_healthy_idx ON ledger.reconciliation_runs (verified_to_seq DESC) WHERE status = 'healthy';

-- Une exécution se termine une seule fois ; son résultat est ensuite figé.
CREATE FUNCTION ledger.reconciliation_runs_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.status <> 'running' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'ledger.reconciliation_runs : exécution terminée, résultat figé';
    END IF;
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
       OR NEW.scope IS DISTINCT FROM OLD.scope THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'ledger.reconciliation_runs : début et exécutant figés';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reconciliation_runs_guard
    BEFORE UPDATE ON ledger.reconciliation_runs
    FOR EACH ROW EXECUTE FUNCTION ledger.reconciliation_runs_guard();
CREATE TRIGGER reconciliation_runs_forbid_delete
    BEFORE DELETE ON ledger.reconciliation_runs
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Preuve externe des ancrages.
-- -----------------------------------------------------------------------------
ALTER TABLE ledger.chain_anchors ADD COLUMN evidence bytea;
ALTER TABLE ledger.chain_anchors ADD COLUMN evidence_type text;
ALTER TABLE ledger.chain_anchors ADD CONSTRAINT chain_anchors_evidence_pair
    CHECK ((evidence IS NULL) = (evidence_type IS NULL));
ALTER TABLE ledger.chain_anchors ADD CONSTRAINT chain_anchors_evidence_type
    CHECK (evidence_type IS NULL OR evidence_type IN ('rfc3161_timestamp_token'));
ALTER TABLE ledger.chain_anchors ADD CONSTRAINT chain_anchors_evidence_size
    CHECK (evidence IS NULL OR octet_length(evidence) BETWEEN 64 AND 65536);

-- -----------------------------------------------------------------------------
-- Privilèges et RLS.
-- -----------------------------------------------------------------------------
REVOKE ALL ON ledger.reconciliation_runs FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.reconciliation_runs TO app_api;
GRANT UPDATE (finished_at, status, verified_from_seq, verified_to_seq, chain_head_seq, chain_head_hash,
              balances_checked, problems, error_message)
    ON ledger.reconciliation_runs TO app_api;
GRANT SELECT ON ledger.reconciliation_runs TO app_readonly, app_auditor;
REVOKE EXECUTE ON FUNCTION ledger.reconciliation_runs_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.reconciliation_runs_guard() TO app_api;

ALTER TABLE ledger.reconciliation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_api_all ON ledger.reconciliation_runs FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_readonly_select ON ledger.reconciliation_runs FOR SELECT TO app_readonly USING (true);
CREATE POLICY app_auditor_select ON ledger.reconciliation_runs FOR SELECT TO app_auditor USING (true);
