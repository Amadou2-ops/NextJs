-- =============================================================================
-- 0022 — Lutte anti-blanchiment : listes de sanctions et PPE, criblage,
--        évaluation de chaque transfert avant paiement.
--
--   * Listes (OFAC SDN, ONU, PPE OpenSanctions) importées avec leur version
--     et leur empreinte : chaque criblage cite l'état exact des listes.
--   * Recherche approximative des noms par trigrammes (pg_trgm), notation
--     fine côté API.
--   * Un transfert financé ne peut passer au paiement qu'avec une
--     évaluation AML favorable ; mis en revue, il n'en sort que lorsque
--     toutes ses alertes bloquantes ont été levées par un humain.
--   * Un client sanctionné ou à risque inacceptable ne peut plus créer de
--     transfert (AM001).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA util;

-- Criblage impossible (listes absentes ou périmées) : aucune preuve de
-- conformité, le transfert attend une revue humaine.
INSERT INTO aml.rules (code, description, severity, blocks_transfer, parameters) VALUES
    ('SCREENING_UNAVAILABLE',
     'Criblage impossible : listes de sanctions absentes ou périmées',
     'critical', true, '{}')
ON CONFLICT (code) DO NOTHING;

CREATE TYPE aml.list_kind AS ENUM ('sanctions', 'pep');
CREATE TYPE aml.entry_type AS ENUM ('individual', 'entity', 'vessel', 'aircraft', 'unknown');
CREATE TYPE aml.evaluation_outcome AS ENUM ('clear', 'review');

-- -----------------------------------------------------------------------------
-- Versions de listes importées.
-- -----------------------------------------------------------------------------
CREATE TABLE aml.list_versions (
    id              bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          text            NOT NULL,
    kind            aml.list_kind   NOT NULL,
    version         text            NOT NULL,
    content_sha256  bytea           NOT NULL,
    entry_count     integer         NOT NULL,
    imported_at     timestamptz     NOT NULL DEFAULT now(),
    is_current      boolean         NOT NULL DEFAULT false,
    CONSTRAINT list_versions_source_format CHECK (source ~ '^[a-z0-9_]{2,40}$'),
    CONSTRAINT list_versions_sha256_len CHECK (octet_length(content_sha256) = 32),
    CONSTRAINT list_versions_count CHECK (entry_count > 0),
    CONSTRAINT list_versions_unique UNIQUE (source, content_sha256)
);

CREATE UNIQUE INDEX list_versions_current_idx ON aml.list_versions (source) WHERE is_current;

CREATE TRIGGER list_versions_freeze_identity
    BEFORE UPDATE ON aml.list_versions
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('is_current');
CREATE TRIGGER list_versions_forbid_delete
    BEFORE DELETE ON aml.list_versions
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Entrées et noms (noms principaux et alias, normalisés). Les entrées d'une
-- version remplacée restent conservées : un criblage passé reste vérifiable.
-- -----------------------------------------------------------------------------
CREATE TABLE aml.list_entries (
    id              bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    list_version_id bigint          NOT NULL REFERENCES aml.list_versions (id),
    external_id     text            NOT NULL,
    entry_type      aml.entry_type  NOT NULL,
    primary_name    text            NOT NULL,
    birth_dates     text[]          NOT NULL DEFAULT '{}',
    countries       text[]          NOT NULL DEFAULT '{}',
    programs        text[]          NOT NULL DEFAULT '{}',
    CONSTRAINT list_entries_unique UNIQUE (list_version_id, external_id),
    CONSTRAINT list_entries_name_len CHECK (char_length(primary_name) BETWEEN 1 AND 500)
);

CREATE TABLE aml.list_entry_names (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id        bigint      NOT NULL REFERENCES aml.list_entries (id),
    list_version_id bigint      NOT NULL REFERENCES aml.list_versions (id),
    name            text        NOT NULL,
    -- Nom normalisé : minuscules, sans diacritiques, jetons triés.
    normalized      text        NOT NULL,
    CONSTRAINT list_entry_names_len CHECK (char_length(normalized) BETWEEN 1 AND 500)
);

CREATE INDEX list_entry_names_trgm_idx ON aml.list_entry_names USING gin (normalized util.gin_trgm_ops);
CREATE INDEX list_entry_names_version_idx ON aml.list_entry_names (list_version_id);

CREATE TRIGGER list_entries_immutable
    BEFORE UPDATE OR DELETE ON aml.list_entries
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER list_entry_names_immutable
    BEFORE UPDATE OR DELETE ON aml.list_entry_names
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Recherche des noms candidats dans les versions courantes (similarité de trigrammes).
CREATE FUNCTION aml.candidate_names(p_normalized text, p_min_similarity real, p_limit integer)
    RETURNS TABLE (entry_id bigint, name text, normalized text, similarity real, source text, kind aml.list_kind,
                   list_version text, entry_type aml.entry_type, primary_name text, birth_dates text[], countries text[],
                   programs text[], external_id text)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, util, pg_temp
AS $$
    SELECT n.entry_id, n.name, n.normalized, similarity(n.normalized, p_normalized) AS similarity,
           v.source, v.kind, v.version, e.entry_type, e.primary_name, e.birth_dates, e.countries, e.programs, e.external_id
      FROM aml.list_entry_names n
      JOIN aml.list_versions v ON v.id = n.list_version_id AND v.is_current
      JOIN aml.list_entries e ON e.id = n.entry_id
     WHERE n.normalized % p_normalized
       AND similarity(n.normalized, p_normalized) >= p_min_similarity
     ORDER BY similarity(n.normalized, p_normalized) DESC
     LIMIT p_limit;
$$;

-- -----------------------------------------------------------------------------
-- Évaluation AML d'un transfert (une par transfert, immuable).
-- -----------------------------------------------------------------------------
CREATE TABLE aml.transfer_evaluations (
    transfer_id             uuid                    PRIMARY KEY REFERENCES transfers.transfers (id),
    outcome                 aml.evaluation_outcome  NOT NULL,
    sender_screening_id     uuid                    REFERENCES aml.screenings (id),
    recipient_screening_id  uuid                    REFERENCES aml.screenings (id),
    -- Résultat de chaque règle évaluée (déclenchée ou non, valeurs mesurées).
    rule_results            jsonb                   NOT NULL,
    risk_score              integer                 NOT NULL,
    evaluated_at            timestamptz             NOT NULL DEFAULT now(),
    CONSTRAINT transfer_evaluations_results_array CHECK (jsonb_typeof(rule_results) = 'array'),
    CONSTRAINT transfer_evaluations_score CHECK (risk_score BETWEEN 0 AND 100)
);

CREATE TRIGGER transfer_evaluations_immutable
    BEFORE UPDATE OR DELETE ON aml.transfer_evaluations
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Une alerte n'est levée (faux positif) ou confirmée que par un membre du personnel.
CREATE FUNCTION aml.alerts_human_resolution()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IN ('closed_false_positive', 'closed_confirmed') AND NEW.status IS DISTINCT FROM OLD.status
       AND COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system') <> 'admin' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'aml.alerts : seule une décision humaine clôt une alerte';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_human_resolution
    BEFORE UPDATE ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION aml.alerts_human_resolution();

-- Profil de risque : un seul par client, créé à la première évaluation.
CREATE INDEX customer_risk_profiles_review_idx ON aml.customer_risk_profiles (next_review_at) WHERE next_review_at IS NOT NULL;

-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION transfers.transfers_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_quote         record;
    v_recipient     record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'created' THEN
            RAISE EXCEPTION USING ERRCODE = 'TR001',
                MESSAGE = 'transfers : un transfert commence obligatoirement au statut created';
        END IF;

        SELECT q.* INTO v_quote FROM fx.quotes q WHERE q.id = NEW.quote_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'transfers : devis inconnu';
        END IF;
        IF v_quote.user_id <> NEW.user_id THEN
            RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'transfers : le devis appartient à un autre client';
        END IF;
        IF v_quote.consumed_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'transfers : devis déjà consommé';
        END IF;
        IF v_quote.expires_at <= now() THEN
            RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'transfers : devis expiré';
        END IF;
        IF (NEW.source_country, NEW.destination_country, NEW.source_currency, NEW.destination_currency,
            NEW.source_amount, NEW.fee_amount, NEW.total_debit, NEW.destination_amount,
            NEW.customer_rate, NEW.usd_equivalent, NEW.payout_method, NEW.funding_method)
           IS DISTINCT FROM
           (v_quote.source_country, v_quote.destination_country, v_quote.source_currency, v_quote.destination_currency,
            v_quote.source_amount, v_quote.fee_amount, v_quote.total_debit, v_quote.destination_amount,
            v_quote.customer_rate, v_quote.usd_equivalent, v_quote.payout_method, v_quote.funding_method) THEN
            RAISE EXCEPTION USING ERRCODE = 'TR002',
                MESSAGE = 'transfers : les montants ou le corridor diffèrent du devis accepté';
        END IF;

        SELECT r.user_id, r.country, r.currency, r.payout_method, r.archived_at
          INTO v_recipient
          FROM transfers.recipients r WHERE r.id = NEW.recipient_id;
        IF v_recipient.user_id <> NEW.user_id OR v_recipient.archived_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers : bénéficiaire invalide pour ce client';
        END IF;
        IF (v_recipient.country, v_recipient.currency, v_recipient.payout_method)
           IS DISTINCT FROM (NEW.destination_country, NEW.destination_currency, NEW.payout_method) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = 'transfers : pays, devise ou mode de paiement du bénéficiaire incompatibles';
        END IF;

        IF NEW.authorized_device_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM identity.devices d
             WHERE d.id = NEW.authorized_device_id AND d.user_id = NEW.user_id AND d.revoked_at IS NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers : appareil d''autorisation invalide';
        END IF;
        IF NEW.authorized_at > now() + interval '1 minute' OR NEW.authorized_at < now() - interval '10 minutes' THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers : autorisation renforcée périmée';
        END IF;

        PERFORM transfers.assert_within_kyc_limits(NEW.user_id, NEW.usd_equivalent);

        -- Client gelé par la conformité (sanction confirmée, risque inacceptable).
        IF EXISTS (
            SELECT 1 FROM aml.customer_risk_profiles p
             WHERE p.user_id = NEW.user_id AND (p.is_sanctioned OR p.risk_level = 'unacceptable')
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'AM001',
                MESSAGE = 'transfers : client bloqué par la conformité';
        END IF;

        UPDATE fx.quotes SET consumed_at = now(), consumed_by_transfer_id = NEW.id WHERE id = NEW.quote_id;
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT EXISTS (
            SELECT 1 FROM transfers.allowed_transitions t
             WHERE t.from_status = OLD.status AND t.to_status = NEW.status
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'TR001',
                MESSAGE = format('transfers : transition %s → %s interdite (%s)', OLD.status, NEW.status, OLD.reference);
        END IF;

        -- Adossement comptable des transitions.
        CASE NEW.status
            WHEN 'payout_pending' THEN
                IF OLD.status = 'funded' AND NOT EXISTS (
                    SELECT 1 FROM aml.transfer_evaluations e WHERE e.transfer_id = NEW.id AND e.outcome = 'clear'
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être payé sans évaluation AML favorable', OLD.reference);
                END IF;
                IF OLD.status IN ('compliance_review', 'payout_failed') AND NOT EXISTS (
                    SELECT 1 FROM aml.transfer_evaluations e WHERE e.transfer_id = NEW.id
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s sans évaluation AML', OLD.reference);
                END IF;
                IF OLD.status = 'compliance_review' AND EXISTS (
                    SELECT 1 FROM aml.alerts a JOIN aml.rules r ON r.code = a.rule_code
                     WHERE a.transfer_id = NEW.id AND r.blocks_transfer
                       AND a.status IN ('open', 'under_review', 'escalated', 'closed_confirmed')
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s a des alertes AML bloquantes non levées', OLD.reference);
                END IF;
            WHEN 'compliance_review' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM aml.transfer_evaluations e WHERE e.transfer_id = NEW.id AND e.outcome = 'review'
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s mis en revue sans évaluation AML', OLD.reference);
                END IF;
            WHEN 'funded' THEN
                IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.idempotency_key = 'transfer:' || NEW.id || ':funding') THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être financé sans écriture de réservation', OLD.reference);
                END IF;
            WHEN 'payout_processing' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout'
                       AND a.status IN ('pending', 'requires_action', 'processing') AND a.ledger_journal_id IS NOT NULL
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s sans paiement sortant comptabilisé en cours', OLD.reference);
                END IF;
            WHEN 'completed' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout' AND a.status = 'succeeded'
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être terminé sans paiement sortant réussi', OLD.reference);
                END IF;
            WHEN 'payout_failed' THEN
                IF EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout'
                       AND a.status IN ('pending', 'requires_action', 'processing', 'succeeded')
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s a un paiement sortant en cours ou réussi', OLD.reference);
                END IF;
            WHEN 'refunded' THEN
                IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.idempotency_key = 'transfer:' || NEW.id || ':refund') THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être remboursé sans écriture de remboursement', OLD.reference);
                END IF;
            ELSE
                NULL;
        END CASE;

        NEW.row_version := OLD.row_version + 1;
        CASE NEW.status
            WHEN 'funded'    THEN NEW.funded_at := COALESCE(NEW.funded_at, now());
            WHEN 'completed' THEN NEW.completed_at := COALESCE(NEW.completed_at, now());
            WHEN 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
            WHEN 'refunded'  THEN NEW.refunded_at := COALESCE(NEW.refunded_at, now());
            ELSE NULL;
        END CASE;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION aml.candidate_names(text, real, integer), aml.alerts_human_resolution() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aml.candidate_names(text, real, integer), aml.alerts_human_resolution(),
                          aml.user_volume_usd(uuid, timestamptz), aml.recipient_distinct_senders(bytea, timestamptz)
    TO app_api;

REVOKE ALL ON aml.list_versions, aml.list_entries, aml.list_entry_names, aml.transfer_evaluations FROM PUBLIC;
GRANT SELECT, INSERT ON aml.list_versions, aml.list_entries, aml.list_entry_names, aml.transfer_evaluations TO app_api;
GRANT UPDATE (is_current) ON aml.list_versions TO app_api;
GRANT SELECT ON aml.list_versions, aml.list_entries, aml.list_entry_names, aml.transfer_evaluations TO app_readonly, app_auditor;

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['list_versions', 'list_entries', 'list_entry_names', 'transfer_evaluations'] LOOP
        EXECUTE format('ALTER TABLE aml.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('CREATE POLICY app_api_all ON aml.%I FOR ALL TO app_api USING (true) WITH CHECK (true)', v_table);
        EXECUTE format('CREATE POLICY app_readonly_select ON aml.%I FOR SELECT TO app_readonly USING (true)', v_table);
        EXECUTE format('CREATE POLICY app_auditor_select ON aml.%I FOR SELECT TO app_auditor USING (true)', v_table);
    END LOOP;
END;
$$;
