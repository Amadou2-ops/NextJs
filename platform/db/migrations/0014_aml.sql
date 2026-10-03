-- =============================================================================
-- 0014 — Lutte anti-blanchiment (AML/CFT) : règles, alertes, dossiers,
--        criblage sanctions/PEP, profils de risque
--
-- Les règles sont évaluées par l'API (phase 8) avant chaque mise en paiement ;
-- toute alerte de sévérité high/critical bloque le transfert en
-- compliance_review jusqu'à décision humaine.
-- =============================================================================

CREATE TABLE aml.rules (
    code            text            PRIMARY KEY,
    description     text            NOT NULL,
    severity        aml.severity    NOT NULL,
    is_enabled      boolean         NOT NULL DEFAULT true,
    -- Paramètres de la règle (seuils en unités mineures USD, fenêtres...).
    parameters      jsonb           NOT NULL DEFAULT '{}'::jsonb,
    -- La règle bloque-t-elle le transfert en attendant une revue humaine ?
    blocks_transfer boolean         NOT NULL DEFAULT false,
    updated_at      timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT rules_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    CONSTRAINT rules_parameters_object CHECK (jsonb_typeof(parameters) = 'object')
);

INSERT INTO aml.rules (code, description, severity, blocks_transfer, parameters) VALUES
    ('SINGLE_LARGE_TRANSFER',
     'Transfert unique supérieur au seuil de déclaration',
     'high', true, '{"threshold_usd_minor": 300000}'),
    ('VELOCITY_24H',
     'Volume cumulé sur 24 heures supérieur au seuil',
     'medium', false, '{"window_hours": 24, "threshold_usd_minor": 500000}'),
    ('VELOCITY_COUNT_1H',
     'Nombre de transferts sur une heure anormalement élevé',
     'medium', false, '{"window_hours": 1, "max_count": 5}'),
    ('STRUCTURING',
     'Fractionnement : plusieurs montants juste sous le seuil sur 7 jours',
     'high', true, '{"window_days": 7, "threshold_usd_minor": 300000, "band_percent": 10, "min_count": 3}'),
    ('SHARED_RECIPIENT',
     'Bénéficiaire commun à de nombreux expéditeurs (mule potentielle)',
     'high', true, '{"window_days": 30, "max_distinct_senders": 5}'),
    ('HIGH_RISK_COUNTRY',
     'Pays d''origine ou de destination à risque élevé',
     'medium', false, '{}'),
    ('SANCTIONS_POTENTIAL_MATCH',
     'Correspondance potentielle sur une liste de sanctions',
     'critical', true, '{}'),
    ('PEP_MATCH',
     'Personne politiquement exposée',
     'high', true, '{}'),
    ('NEW_DEVICE_LARGE_TRANSFER',
     'Montant élevé depuis un appareil enregistré il y a moins de 24 heures',
     'medium', true, '{"device_age_hours": 24, "threshold_usd_minor": 100000}'),
    ('RAPID_IN_OUT',
     'Fonds reçus puis renvoyés intégralement en moins de 24 heures',
     'medium', false, '{"window_hours": 24, "ratio_percent": 90}');

CREATE TRIGGER rules_set_updated_at
    BEFORE UPDATE ON aml.rules
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER rules_forbid_delete
    BEFORE DELETE ON aml.rules
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Profil de risque client (recalculé à chaque événement significatif).
-- -----------------------------------------------------------------------------
CREATE TABLE aml.customer_risk_profiles (
    user_id             uuid            PRIMARY KEY REFERENCES identity.users (id),
    risk_level          aml.risk_level  NOT NULL DEFAULT 'medium',
    risk_score          integer         NOT NULL DEFAULT 50,
    is_pep              boolean         NOT NULL DEFAULT false,
    is_sanctioned       boolean         NOT NULL DEFAULT false,
    enhanced_due_diligence boolean      NOT NULL DEFAULT false,
    factors             jsonb           NOT NULL DEFAULT '{}'::jsonb,
    last_assessed_at    timestamptz     NOT NULL DEFAULT now(),
    next_review_at      timestamptz,
    updated_at          timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT risk_profiles_score_range CHECK (risk_score BETWEEN 0 AND 100),
    CONSTRAINT risk_profiles_sanctioned_unacceptable CHECK (NOT is_sanctioned OR risk_level = 'unacceptable'),
    CONSTRAINT risk_profiles_pep_edd CHECK (NOT is_pep OR enhanced_due_diligence),
    CONSTRAINT risk_profiles_factors_object CHECK (jsonb_typeof(factors) = 'object')
);

CREATE TRIGGER customer_risk_profiles_set_updated_at
    BEFORE UPDATE ON aml.customer_risk_profiles
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER customer_risk_profiles_forbid_delete
    BEFORE DELETE ON aml.customer_risk_profiles
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Criblage sanctions / PEP / médias défavorables.
-- -----------------------------------------------------------------------------
CREATE TABLE aml.screenings (
    id                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type        aml.screening_subject   NOT NULL,
    subject_id          uuid                    NOT NULL,
    provider            text                    NOT NULL,
    provider_reference  text,
    status              aml.screening_status    NOT NULL,
    -- Versions des listes consultées (OFAC SDN, UE, ONU, HMT...) : preuve de
    -- l'état des listes au moment du contrôle.
    list_versions       jsonb                   NOT NULL DEFAULT '{}'::jsonb,
    match_details       jsonb                   NOT NULL DEFAULT '{}'::jsonb,
    reviewed_by_admin_id uuid,
    reviewed_at         timestamptz,
    review_note         text,
    screened_at         timestamptz             NOT NULL DEFAULT now(),
    CONSTRAINT screenings_provider_format CHECK (provider ~ '^[a-z0-9_]{2,50}$'),
    CONSTRAINT screenings_review_triplet CHECK (
        (reviewed_by_admin_id IS NULL) = (reviewed_at IS NULL)
        AND (reviewed_at IS NULL OR review_note IS NOT NULL)
    ),
    CONSTRAINT screenings_resolution_reviewed CHECK (
        status NOT IN ('confirmed_match', 'false_positive') OR reviewed_at IS NOT NULL
    ),
    CONSTRAINT screenings_json_objects CHECK (
        jsonb_typeof(list_versions) = 'object' AND jsonb_typeof(match_details) = 'object'
    )
);

CREATE INDEX screenings_subject_idx ON aml.screenings (subject_type, subject_id, screened_at DESC);
CREATE INDEX screenings_pending_review_idx ON aml.screenings (screened_at) WHERE status = 'potential_match';

-- Seule la résolution d'une correspondance potentielle est modifiable.
CREATE TRIGGER screenings_freeze_identity
    BEFORE UPDATE ON aml.screenings
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'reviewed_by_admin_id', 'reviewed_at', 'review_note'
    );

CREATE FUNCTION aml.screenings_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'potential_match' OR NEW.status NOT IN ('confirmed_match', 'false_positive') THEN
            RAISE EXCEPTION USING ERRCODE = 'LG006',
                MESSAGE = format('aml.screenings : résolution %s → %s interdite', OLD.status, NEW.status);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER screenings_guard
    BEFORE UPDATE ON aml.screenings
    FOR EACH ROW EXECUTE FUNCTION aml.screenings_guard();
CREATE TRIGGER screenings_forbid_delete
    BEFORE DELETE ON aml.screenings
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Alertes.
-- -----------------------------------------------------------------------------
CREATE TABLE aml.alerts (
    id                  uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid                NOT NULL REFERENCES identity.users (id),
    transfer_id         uuid                REFERENCES transfers.transfers (id),
    screening_id        uuid                REFERENCES aml.screenings (id),
    rule_code           text                NOT NULL REFERENCES aml.rules (code),
    severity            aml.severity        NOT NULL,
    score               integer             NOT NULL,
    status              aml.alert_status    NOT NULL DEFAULT 'open',
    details             jsonb               NOT NULL DEFAULT '{}'::jsonb,
    assigned_to_admin_id uuid,
    resolution_note     text,
    resolved_by_admin_id uuid,
    created_at          timestamptz         NOT NULL DEFAULT now(),
    updated_at          timestamptz         NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    CONSTRAINT alerts_score_range CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT alerts_details_object CHECK (jsonb_typeof(details) = 'object'),
    -- Une alerte n'est close que par un humain identifié, avec un motif.
    CONSTRAINT alerts_resolution CHECK (
        status NOT IN ('closed_false_positive', 'closed_confirmed')
        OR (resolved_at IS NOT NULL AND resolved_by_admin_id IS NOT NULL AND char_length(resolution_note) >= 10)
    )
);

CREATE INDEX alerts_queue_idx ON aml.alerts (severity, created_at) WHERE status IN ('open', 'under_review', 'escalated');
CREATE INDEX alerts_user_idx ON aml.alerts (user_id, created_at DESC);
CREATE INDEX alerts_transfer_idx ON aml.alerts (transfer_id) WHERE transfer_id IS NOT NULL;
-- Une règle ne déclenche qu'une alerte par transfert.
CREATE UNIQUE INDEX alerts_rule_transfer_unique_idx ON aml.alerts (rule_code, transfer_id)
    WHERE transfer_id IS NOT NULL;

CREATE TRIGGER alerts_set_updated_at
    BEFORE UPDATE ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER alerts_freeze_identity
    BEFORE UPDATE ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'assigned_to_admin_id', 'resolution_note', 'resolved_by_admin_id',
        'updated_at', 'resolved_at'
    );

CREATE FUNCTION aml.alerts_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.status IN ('closed_false_positive', 'closed_confirmed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'aml.alerts : une alerte close est définitive';
    END IF;
    IF NEW.status IN ('closed_false_positive', 'closed_confirmed') AND OLD.status NOT IN ('closed_false_positive', 'closed_confirmed') THEN
        NEW.resolved_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_guard
    BEFORE UPDATE ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION aml.alerts_guard();
CREATE TRIGGER alerts_forbid_delete
    BEFORE DELETE ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Dossiers d'enquête (regroupent des alertes ; peuvent aboutir à une
-- déclaration de soupçon : SAR / déclaration TRACFIN / CENTIF...).
-- -----------------------------------------------------------------------------
CREATE TABLE aml.cases (
    id                      uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    case_number             bigint              GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
    user_id                 uuid                NOT NULL REFERENCES identity.users (id),
    status                  aml.case_status     NOT NULL DEFAULT 'open',
    summary                 text                NOT NULL,
    opened_by_admin_id      uuid                NOT NULL,
    assigned_to_admin_id    uuid,
    sar_reference           text,
    sar_filed_at            timestamptz,
    closure_note            text,
    created_at              timestamptz         NOT NULL DEFAULT now(),
    updated_at              timestamptz         NOT NULL DEFAULT now(),
    closed_at               timestamptz,
    CONSTRAINT cases_sar_consistency CHECK (
        status <> 'sar_filed' OR (sar_reference IS NOT NULL AND sar_filed_at IS NOT NULL)
    ),
    CONSTRAINT cases_closure CHECK (
        status <> 'closed' OR (closed_at IS NOT NULL AND char_length(closure_note) >= 10)
    ),
    CONSTRAINT cases_summary_len CHECK (char_length(summary) BETWEEN 10 AND 5000)
);

CREATE INDEX cases_user_idx ON aml.cases (user_id);
CREATE INDEX cases_open_idx ON aml.cases (created_at) WHERE status <> 'closed';

CREATE TRIGGER cases_set_updated_at
    BEFORE UPDATE ON aml.cases
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER cases_freeze_identity
    BEFORE UPDATE ON aml.cases
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'summary', 'assigned_to_admin_id', 'sar_reference', 'sar_filed_at',
        'closure_note', 'updated_at', 'closed_at'
    );
CREATE TRIGGER cases_forbid_delete
    BEFORE DELETE ON aml.cases
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE TABLE aml.case_alerts (
    case_id     uuid        NOT NULL REFERENCES aml.cases (id),
    alert_id    uuid        NOT NULL REFERENCES aml.alerts (id),
    linked_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, alert_id)
);

CREATE TRIGGER case_alerts_immutable
    BEFORE UPDATE OR DELETE ON aml.case_alerts
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Cumul de l'équivalent USD des transferts d'un client sur une fenêtre
-- (plafonds KYC et règles de vélocité). Les transferts annulés ou remboursés
-- ne comptent pas.
-- -----------------------------------------------------------------------------
CREATE FUNCTION aml.user_volume_usd(p_user_id uuid, p_since timestamptz)
    RETURNS TABLE (transfer_count bigint, total_usd_minor bigint)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT count(*),
           COALESCE(sum(t.usd_equivalent), 0)::bigint
      FROM transfers.transfers t
     WHERE t.user_id = p_user_id
       AND t.created_at >= p_since
       AND t.status NOT IN ('cancelled', 'refunded');
$$;

-- Nombre d'expéditeurs distincts vers les mêmes coordonnées bénéficiaire.
CREATE FUNCTION aml.recipient_distinct_senders(p_account_details_bidx bytea, p_since timestamptz)
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT count(DISTINCT t.user_id)
      FROM transfers.transfers t
      JOIN transfers.recipients r ON r.id = t.recipient_id
     WHERE r.account_details_bidx = p_account_details_bidx
       AND t.created_at >= p_since
       AND t.status NOT IN ('cancelled', 'refunded');
$$;
