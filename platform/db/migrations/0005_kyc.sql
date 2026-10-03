-- =============================================================================
-- 0005 — KYC : vérifications d'identité, documents, historique de revue,
--        plafonds par niveau.
--
-- Les fichiers (pièces d'identité, vidéos de vivacité) sont stockés chiffrés
-- dans un bucket privé ; la base ne conserve que leur emplacement, leur
-- empreinte SHA-256 (preuve d'intégrité) et l'identifiant de clé.
-- =============================================================================

CREATE TABLE kyc.verifications (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid                        NOT NULL REFERENCES identity.users (id),
    provider                kyc.provider                NOT NULL,
    job_type                kyc.job_type                NOT NULL,
    tier_requested          kyc.kyc_tier                NOT NULL,
    status                  kyc.verification_status     NOT NULL DEFAULT 'created',
    -- Identifiant du dossier chez le prestataire (job_id Smile ID, check_id Onfido).
    provider_reference      text,
    -- Résumé non nominatif du résultat (codes, scores) ; jamais de données brutes.
    provider_result_code    text,
    provider_result         jsonb                       NOT NULL DEFAULT '{}'::jsonb,
    liveness_score          numeric(5, 4),
    document_match_score    numeric(5, 4),
    rejection_reasons       text[]                      NOT NULL DEFAULT '{}',
    submitted_at            timestamptz,
    decided_at              timestamptz,
    -- Décision manuelle par un membre du personnel (NULL si automatique).
    -- Clé étrangère vers backoffice.admin_users ajoutée en 0015.
    decided_by_admin_id     uuid,
    expires_at              timestamptz,
    row_version             integer                     NOT NULL DEFAULT 1,
    created_at              timestamptz                 NOT NULL DEFAULT now(),
    updated_at              timestamptz                 NOT NULL DEFAULT now(),
    CONSTRAINT verifications_provider_ref_unique UNIQUE (provider, provider_reference),
    CONSTRAINT verifications_scores_range CHECK (
        (liveness_score IS NULL OR liveness_score BETWEEN 0 AND 1)
        AND (document_match_score IS NULL OR document_match_score BETWEEN 0 AND 1)
    ),
    CONSTRAINT verifications_decision_consistency CHECK (
        status NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL
    ),
    CONSTRAINT verifications_tier_requested CHECK (tier_requested <> 'tier_0'),
    CONSTRAINT verifications_result_object CHECK (jsonb_typeof(provider_result) = 'object')
);

CREATE INDEX verifications_user_idx ON kyc.verifications (user_id, created_at DESC);
-- File d'attente du dashboard admin (revue manuelle).
CREATE INDEX verifications_review_queue_idx ON kyc.verifications (created_at)
    WHERE status IN ('submitted', 'in_review');

CREATE TRIGGER verifications_set_updated_at
    BEFORE UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

CREATE TRIGGER verifications_freeze_identity
    BEFORE UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'provider_reference', 'provider_result_code', 'provider_result',
        'liveness_score', 'document_match_score', 'rejection_reasons', 'submitted_at',
        'decided_at', 'decided_by_admin_id', 'expires_at', 'row_version', 'updated_at'
    );

CREATE TRIGGER verifications_forbid_delete
    BEFORE DELETE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Machine à états KYC : seules les transitions listées sont permises.
CREATE TABLE kyc.allowed_transitions (
    from_status kyc.verification_status NOT NULL,
    to_status   kyc.verification_status NOT NULL,
    PRIMARY KEY (from_status, to_status)
);

INSERT INTO kyc.allowed_transitions (from_status, to_status) VALUES
    ('created',               'pending_submission'),
    ('created',               'submitted'),
    ('created',               'expired'),
    ('pending_submission',    'submitted'),
    ('pending_submission',    'expired'),
    ('submitted',             'in_review'),
    ('submitted',             'approved'),
    ('submitted',             'rejected'),
    ('submitted',             'resubmission_required'),
    ('in_review',             'approved'),
    ('in_review',             'rejected'),
    ('in_review',             'resubmission_required'),
    ('resubmission_required', 'submitted'),
    ('resubmission_required', 'expired'),
    ('approved',              'expired');

-- Historique de revue, en ajout seul, alimenté automatiquement à chaque
-- changement de statut.
CREATE TABLE kyc.review_events (
    id                  bigint                      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    verification_id     uuid                        NOT NULL REFERENCES kyc.verifications (id),
    from_status         kyc.verification_status,
    to_status           kyc.verification_status     NOT NULL,
    actor_type          kyc.actor_type              NOT NULL,
    actor_id            text,
    note                text,
    created_at          timestamptz                 NOT NULL DEFAULT now()
);

CREATE INDEX review_events_verification_idx ON kyc.review_events (verification_id, id);

CREATE TRIGGER review_events_immutable
    BEFORE UPDATE OR DELETE ON kyc.review_events
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER review_events_no_truncate
    BEFORE TRUNCATE ON kyc.review_events
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- Validation des transitions (avant écriture).
CREATE FUNCTION kyc.verifications_status_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor_type kyc.actor_type := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system')::kyc.actor_type;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'created' THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = 'kyc.verifications : une vérification commence obligatoirement au statut created';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT EXISTS (
            SELECT 1 FROM kyc.allowed_transitions t
             WHERE t.from_status = OLD.status AND t.to_status = NEW.status
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'TR001',
                MESSAGE = format('kyc.verifications : transition %s → %s interdite', OLD.status, NEW.status);
        END IF;
        IF v_actor_type = 'admin' AND NEW.status IN ('approved', 'rejected') AND NEW.decided_by_admin_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = 'kyc.verifications : une décision manuelle doit identifier l''administrateur';
        END IF;
        NEW.row_version := OLD.row_version + 1;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER verifications_status_guard
    BEFORE INSERT OR UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.verifications_status_guard();

-- Historisation après écriture (la ligne existe, la clé étrangère est valide).
-- L'API renseigne l'acteur par variables de transaction :
--   SET LOCAL app.actor_type = 'admin'; SET LOCAL app.actor_id = '<uuid>';
--   SET LOCAL app.change_note = '...';
CREATE FUNCTION kyc.verifications_record_history()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor_type kyc.actor_type := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system')::kyc.actor_type;
    v_actor_id   text := NULLIF(current_setting('app.actor_id', true), '');
    v_note       text := NULLIF(current_setting('app.change_note', true), '');
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO kyc.review_events (verification_id, from_status, to_status, actor_type, actor_id, note)
        VALUES (NEW.id, NULL, NEW.status, v_actor_type, v_actor_id, v_note);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO kyc.review_events (verification_id, from_status, to_status, actor_type, actor_id, note)
        VALUES (NEW.id, OLD.status, NEW.status, v_actor_type, v_actor_id, v_note);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER verifications_record_history
    AFTER INSERT OR UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.verifications_record_history();

-- -----------------------------------------------------------------------------
-- Documents (pièces, selfies, vidéos de vivacité). Immuables.
-- -----------------------------------------------------------------------------
CREATE TABLE kyc.documents (
    id                      uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_id         uuid                NOT NULL REFERENCES kyc.verifications (id),
    user_id                 uuid                NOT NULL REFERENCES identity.users (id),
    document_type           kyc.document_type   NOT NULL,
    issuing_country         char(2)             REFERENCES ref.countries (alpha2),
    storage_bucket          text                NOT NULL,
    storage_path            text                NOT NULL,
    content_sha256          bytea               NOT NULL,
    mime_type               text                NOT NULL,
    size_bytes              bigint              NOT NULL,
    encryption_key_id       text                NOT NULL,
    document_number_enc     bytea,
    document_number_bidx    bytea,
    document_expiry_enc     bytea,
    captured_at             timestamptz         NOT NULL,
    created_at              timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT documents_storage_unique UNIQUE (storage_bucket, storage_path),
    CONSTRAINT documents_sha256_len CHECK (octet_length(content_sha256) = 32),
    CONSTRAINT documents_size_range CHECK (size_bytes > 0 AND size_bytes <= 104857600),
    CONSTRAINT documents_mime_allowed CHECK (
        mime_type IN ('image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'video/mp4', 'video/quicktime')
    ),
    CONSTRAINT documents_number_pair CHECK ((document_number_enc IS NULL) = (document_number_bidx IS NULL)),
    CONSTRAINT documents_identity_needs_country CHECK (
        document_type IN ('selfie_image', 'selfie_video', 'proof_of_address') OR issuing_country IS NOT NULL
    ),
    CONSTRAINT documents_path_safe CHECK (storage_path !~ '\.\.' AND storage_path !~ '^/')
);

CREATE INDEX documents_verification_idx ON kyc.documents (verification_id);
-- Détection d'une même pièce utilisée par plusieurs comptes (fraude).
CREATE INDEX documents_number_bidx_idx ON kyc.documents (document_number_bidx)
    WHERE document_number_bidx IS NOT NULL;

CREATE TRIGGER documents_immutable
    BEFORE UPDATE OR DELETE ON kyc.documents
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER documents_no_truncate
    BEFORE TRUNCATE ON kyc.documents
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- -----------------------------------------------------------------------------
-- Plafonds par niveau KYC, exprimés en unités mineures de la devise pivot
-- (USD) et appliqués sur l'équivalent USD de chaque transfert.
-- -----------------------------------------------------------------------------
CREATE TABLE kyc.tier_limits (
    tier                    kyc.kyc_tier    PRIMARY KEY,
    pivot_currency          char(3)         NOT NULL DEFAULT 'USD',
    single_transfer_max     bigint          NOT NULL,
    daily_max               bigint          NOT NULL,
    monthly_max             bigint          NOT NULL,
    annual_max              bigint          NOT NULL,
    updated_at              timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT tier_limits_pivot_usd CHECK (pivot_currency = 'USD'),
    CONSTRAINT tier_limits_ordering CHECK (
        single_transfer_max >= 0
        AND single_transfer_max <= daily_max
        AND daily_max <= monthly_max
        AND monthly_max <= annual_max
    )
);

-- Valeurs initiales prudentes, à valider par la conformité pour chaque
-- licence (EMI, MSB...). tier_0 = compte non vérifié : aucun envoi possible.
INSERT INTO kyc.tier_limits (tier, single_transfer_max, daily_max, monthly_max, annual_max) VALUES
    ('tier_0',        0,          0,           0,            0),
    ('tier_1',    50000,     100000,      300000,      1000000),
    ('tier_2',   300000,     500000,     1500000,      6000000),
    ('tier_3',  1000000,    2000000,     5000000,     25000000);

CREATE TRIGGER tier_limits_set_updated_at
    BEFORE UPDATE ON kyc.tier_limits
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

CREATE TRIGGER tier_limits_forbid_delete
    BEFORE DELETE ON kyc.tier_limits
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
