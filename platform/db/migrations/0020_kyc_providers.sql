-- =============================================================================
-- 0020 — KYC : routage vers les prestataires, dossiers prestataires, preuves
--        d'identité extraites, invariants de niveau.
--
-- Principes :
--   * Le niveau KYC d'un client (identity.users.kyc_tier) n'est JAMAIS écrit
--     librement : il est relevé par la base elle-même lorsqu'une vérification
--     est approuvée, et recalculé lorsqu'une vérification expire. Toute autre
--     hausse est refusée.
--   * Une approbation automatique (prestataire, système) exige une preuve
--     d'identité concordante avec l'identité déclarée ; une pièce déjà
--     rattachée à un autre client approuvé ne peut être approuvée que par une
--     décision humaine (revue manuelle).
--   * L'identité déclarée est figée dès qu'une vérification est en cours ou
--     qu'un niveau a été accordé.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Routage : quel prestataire et quel type de contrôle pour un pays de
-- résidence et un niveau demandé. country_of_residence NULL = règle par
-- défaut. La règle la plus spécifique l'emporte, puis la priorité la plus
-- basse ; un prestataire non configuré côté API est ignoré au profit de la
-- règle suivante.
-- -----------------------------------------------------------------------------
CREATE TABLE kyc.provider_routes (
    id                      uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    country_of_residence    char(2)         REFERENCES ref.countries (alpha2),
    tier                    kyc.kyc_tier    NOT NULL,
    provider                kyc.provider    NOT NULL,
    job_type                kyc.job_type    NOT NULL,
    priority                integer         NOT NULL DEFAULT 100,
    is_enabled              boolean         NOT NULL DEFAULT true,
    created_at              timestamptz     NOT NULL DEFAULT now(),
    updated_at              timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT provider_routes_unique UNIQUE NULLS NOT DISTINCT (country_of_residence, tier, provider, job_type),
    CONSTRAINT provider_routes_tier CHECK (tier IN ('tier_1', 'tier_2')),
    CONSTRAINT provider_routes_priority CHECK (priority BETWEEN 0 AND 1000),
    -- Combinaisons réellement prises en charge par chaque prestataire.
    CONSTRAINT provider_routes_supported CHECK (
        (provider = 'onfido' AND job_type IN ('document_verification', 'proof_of_address'))
        OR (provider = 'smile_id' AND job_type IN ('document_verification', 'biometric_kyc'))
    ),
    -- Le niveau 2 inclut la preuve de domicile ; le niveau 1 la pièce + selfie.
    CONSTRAINT provider_routes_tier_job CHECK (
        (tier = 'tier_1' AND job_type IN ('document_verification', 'biometric_kyc'))
        OR (tier = 'tier_2' AND job_type = 'proof_of_address')
    )
);

CREATE INDEX provider_routes_lookup_idx ON kyc.provider_routes (tier, country_of_residence) WHERE is_enabled;

CREATE TRIGGER provider_routes_set_updated_at
    BEFORE UPDATE ON kyc.provider_routes
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER provider_routes_freeze_identity
    BEFORE UPDATE ON kyc.provider_routes
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('priority', 'is_enabled', 'updated_at');
CREATE TRIGGER provider_routes_forbid_delete
    BEFORE DELETE ON kyc.provider_routes
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Dossier du client chez un prestataire (applicant Onfido). Un seul par
-- client et prestataire, immuable : toutes ses vérifications y sont
-- rattachées, ce qui permet au prestataire de détecter les réutilisations.
-- -----------------------------------------------------------------------------
CREATE TABLE kyc.provider_applicants (
    user_id                 uuid            NOT NULL REFERENCES identity.users (id),
    provider                kyc.provider    NOT NULL,
    applicant_reference     text            NOT NULL,
    created_at              timestamptz     NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider),
    CONSTRAINT provider_applicants_reference_unique UNIQUE (provider, applicant_reference),
    CONSTRAINT provider_applicants_reference_format CHECK (applicant_reference ~ '^[A-Za-z0-9_-]{1,128}$')
);

CREATE TRIGGER provider_applicants_immutable
    BEFORE UPDATE OR DELETE ON kyc.provider_applicants
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Preuve d'identité extraite par le prestataire, une par vérification.
-- Données nominatives chiffrées (enveloppe AES-256-GCM, contexte lié à la
-- vérification) ; le numéro de pièce est aussi indexé à l'aveugle (HMAC) pour
-- détecter une même pièce présentée par plusieurs comptes.
-- -----------------------------------------------------------------------------
CREATE TABLE kyc.identity_evidence (
    verification_id             uuid                PRIMARY KEY REFERENCES kyc.verifications (id),
    user_id                     uuid                NOT NULL REFERENCES identity.users (id),
    provider                    kyc.provider        NOT NULL,
    document_type               kyc.document_type,
    issuing_country             char(2)             REFERENCES ref.countries (alpha2),
    document_number_enc         bytea,
    document_number_bidx        bytea,
    -- Nom complet tel que lu sur la pièce (prénoms et noms, ordre du document).
    full_name_enc               bytea,
    date_of_birth_enc           bytea,
    pii_key_id                  text                NOT NULL,
    -- Concordance avec l'identité déclarée (nom, prénom, date de naissance).
    -- NULL : comparaison impossible (données manquantes côté prestataire).
    declared_identity_match     boolean,
    created_at                  timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT identity_evidence_number_pair CHECK ((document_number_enc IS NULL) = (document_number_bidx IS NULL)),
    CONSTRAINT identity_evidence_bidx_len CHECK (document_number_bidx IS NULL OR octet_length(document_number_bidx) = 32),
    CONSTRAINT identity_evidence_number_country CHECK (document_number_bidx IS NULL OR issuing_country IS NOT NULL),
    CONSTRAINT identity_evidence_identity_document CHECK (
        document_type IS NULL OR document_type IN ('passport', 'national_id', 'driving_licence', 'residence_permit')
    )
);

CREATE INDEX identity_evidence_number_idx ON kyc.identity_evidence (document_number_bidx)
    WHERE document_number_bidx IS NOT NULL;
CREATE INDEX identity_evidence_user_idx ON kyc.identity_evidence (user_id);

-- La preuve appartient au client de la vérification.
CREATE FUNCTION kyc.identity_evidence_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM kyc.verifications v
         WHERE v.id = NEW.verification_id AND v.user_id = NEW.user_id AND v.provider = NEW.provider
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'kyc.identity_evidence : client ou prestataire différent de la vérification';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER identity_evidence_guard
    BEFORE INSERT ON kyc.identity_evidence
    FOR EACH ROW EXECUTE FUNCTION kyc.identity_evidence_guard();
CREATE TRIGGER identity_evidence_immutable
    BEFORE UPDATE OR DELETE ON kyc.identity_evidence
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER identity_evidence_no_truncate
    BEFORE TRUNCATE ON kyc.identity_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- -----------------------------------------------------------------------------
-- Une seule vérification en cours par client.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX verifications_one_active_idx ON kyc.verifications (user_id)
    WHERE status IN ('created', 'pending_submission', 'submitted', 'in_review', 'resubmission_required');

-- Recherche par référence prestataire (webhooks).
CREATE INDEX verifications_open_by_provider_idx ON kyc.verifications (provider, updated_at)
    WHERE status IN ('pending_submission', 'submitted', 'in_review');

-- -----------------------------------------------------------------------------
-- Garde d'approbation (avant écriture).
-- -----------------------------------------------------------------------------
CREATE FUNCTION kyc.verifications_approval_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor_type    text := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system');
    v_evidence      record;
BEGIN
    IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
        IF NEW.expires_at IS NULL OR NEW.expires_at <= now() THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = 'kyc.verifications : une approbation doit porter une date d''expiration future';
        END IF;

        IF v_actor_type <> 'admin' THEN
            SELECT e.* INTO v_evidence FROM kyc.identity_evidence e WHERE e.verification_id = NEW.id;
            IF NOT FOUND OR v_evidence.declared_identity_match IS DISTINCT FROM true THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007',
                    MESSAGE = 'kyc.verifications : approbation automatique sans preuve d''identité concordante';
            END IF;
            IF v_evidence.document_number_bidx IS NOT NULL AND EXISTS (
                SELECT 1
                  FROM kyc.identity_evidence other
                  JOIN kyc.verifications ov ON ov.id = other.verification_id
                 WHERE other.document_number_bidx = v_evidence.document_number_bidx
                   AND other.user_id <> NEW.user_id
                   AND ov.status IN ('approved', 'expired')
            ) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007',
                    MESSAGE = 'kyc.verifications : pièce déjà rattachée à un autre client, revue manuelle obligatoire';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER verifications_approval_guard
    BEFORE UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.verifications_approval_guard();

-- -----------------------------------------------------------------------------
-- Niveau du client : relevé à l'approbation, recalculé à l'expiration.
-- -----------------------------------------------------------------------------
CREATE FUNCTION kyc.effective_tier(p_user_id uuid)
    RETURNS kyc.kyc_tier
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT COALESCE(max(v.tier_requested), 'tier_0'::kyc.kyc_tier)
      FROM kyc.verifications v
     WHERE v.user_id = p_user_id
       AND v.status = 'approved'
       AND v.expires_at > now();
$$;

CREATE FUNCTION kyc.verifications_apply_tier()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status = 'approved' OR OLD.status = 'approved') THEN
        UPDATE identity.users u
           SET kyc_tier = kyc.effective_tier(NEW.user_id)
         WHERE u.id = NEW.user_id
           AND u.kyc_tier IS DISTINCT FROM kyc.effective_tier(NEW.user_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER verifications_apply_tier
    AFTER UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.verifications_apply_tier();

-- Garde côté client : un compte naît au niveau 0 ; le niveau ne peut monter
-- qu'au niveau effectivement justifié par des vérifications approuvées ;
-- l'identité déclarée est figée pendant une vérification et après l'octroi
-- d'un niveau.
CREATE FUNCTION identity.users_kyc_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.kyc_tier <> 'tier_0' THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = 'identity.users : un compte est créé au niveau KYC tier_0';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.kyc_tier > OLD.kyc_tier AND NEW.kyc_tier > kyc.effective_tier(NEW.id) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('identity.users : niveau %s non justifié par une vérification approuvée', NEW.kyc_tier);
    END IF;

    IF (NEW.first_name_enc, NEW.last_name_enc, NEW.date_of_birth_enc)
       IS DISTINCT FROM (OLD.first_name_enc, OLD.last_name_enc, OLD.date_of_birth_enc)
       AND (OLD.kyc_tier <> 'tier_0' OR EXISTS (
               SELECT 1 FROM kyc.verifications v
                WHERE v.user_id = NEW.id
                  AND v.status IN ('created', 'pending_submission', 'submitted', 'in_review', 'resubmission_required')))
    THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.users : identité déclarée figée (vérification en cours ou niveau accordé)';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_kyc_guard
    BEFORE INSERT OR UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION identity.users_kyc_guard();

REVOKE EXECUTE ON FUNCTION kyc.identity_evidence_guard(), kyc.verifications_approval_guard(),
                           kyc.verifications_apply_tier(), identity.users_kyc_guard(),
                           kyc.effective_tier(uuid)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kyc.identity_evidence_guard(), kyc.verifications_approval_guard(),
                          kyc.verifications_apply_tier(), identity.users_kyc_guard(),
                          kyc.effective_tier(uuid)
    TO app_api;

-- -----------------------------------------------------------------------------
-- Droits et RLS.
-- -----------------------------------------------------------------------------
REVOKE ALL ON kyc.provider_routes, kyc.provider_applicants, kyc.identity_evidence FROM PUBLIC;
GRANT SELECT ON kyc.provider_routes TO app_api;
GRANT UPDATE (priority, is_enabled) ON kyc.provider_routes TO app_api;
GRANT SELECT, INSERT ON kyc.provider_applicants, kyc.identity_evidence TO app_api;
GRANT SELECT ON kyc.provider_routes, kyc.provider_applicants TO app_readonly;
GRANT SELECT (verification_id, user_id, provider, document_type, issuing_country, declared_identity_match, created_at)
    ON kyc.identity_evidence TO app_readonly;

ALTER TABLE kyc.provider_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.provider_applicants ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.identity_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_api_all ON kyc.provider_routes FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_api_all ON kyc.provider_applicants FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_api_all ON kyc.identity_evidence FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_readonly_select ON kyc.provider_routes FOR SELECT TO app_readonly USING (true);
CREATE POLICY app_readonly_select ON kyc.provider_applicants FOR SELECT TO app_readonly USING (true);
CREATE POLICY app_readonly_select ON kyc.identity_evidence FOR SELECT TO app_readonly USING (true);
