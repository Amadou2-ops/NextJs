-- =============================================================================
-- 0017 — Authentification : défis d'attestation d'appareil, défis de
--        connexion à deux facteurs, défis WebAuthn, anti-rejeu TOTP
--
-- Tous les défis sont à usage unique, de courte durée, et consommés de façon
-- définitive (triggers). Les codes ne sont jamais stockés en clair : le code
-- SMS est dans identity.otp_challenges sous forme de HMAC, le TOTP est
-- recalculé à partir du secret chiffré.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Anti-rejeu TOTP : un même pas de temps (30 s) ne peut être utilisé qu'une
-- fois, même s'il reste valide pendant la fenêtre de tolérance.
-- -----------------------------------------------------------------------------
ALTER TABLE identity.users ADD COLUMN mfa_totp_last_used_step bigint;
ALTER TABLE identity.users ADD CONSTRAINT users_totp_step_positive
    CHECK (mfa_totp_last_used_step IS NULL OR mfa_totp_last_used_step > 0);

DROP TRIGGER users_freeze_identity ON identity.users;
CREATE TRIGGER users_freeze_identity
    BEFORE UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'phone_bidx', 'phone_enc', 'phone_country', 'phone_verified_at',
        'email_bidx', 'email_enc', 'email_verified_at', 'password_hash',
        'password_changed_at', 'first_name_enc', 'last_name_enc', 'date_of_birth_enc',
        'address_enc', 'nationality', 'country_of_residence', 'pii_key_id', 'kyc_tier',
        'preferred_locale', 'mfa_totp_secret_enc', 'mfa_totp_enabled_at',
        'mfa_totp_last_used_step', 'failed_login_count', 'locked_until', 'last_login_at',
        'row_version', 'updated_at', 'suspended_at', 'closed_at'
    );

CREATE FUNCTION identity.users_totp_step_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.mfa_totp_last_used_step IS NOT NULL
       AND NEW.mfa_totp_last_used_step IS NOT NULL
       AND NEW.mfa_totp_last_used_step <= OLD.mfa_totp_last_used_step
       AND NEW.mfa_totp_secret_enc IS NOT DISTINCT FROM OLD.mfa_totp_secret_enc THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.users : un code TOTP déjà utilisé ne peut pas être réutilisé';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_totp_step_guard
    BEFORE UPDATE OF mfa_totp_last_used_step ON identity.users
    FOR EACH ROW EXECUTE FUNCTION identity.users_totp_step_guard();

-- -----------------------------------------------------------------------------
-- Défis d'attestation d'appareil (nonce serveur pour App Attest / Play
-- Integrity). L'application l'intègre à l'attestation de sa clé publique.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.device_challenges (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge       bytea       NOT NULL UNIQUE,
    ip_address      inet,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    CONSTRAINT device_challenges_len CHECK (octet_length(challenge) = 32),
    CONSTRAINT device_challenges_expiry CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
    )
);

CREATE INDEX device_challenges_expiry_idx ON identity.device_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TRIGGER device_challenges_freeze_identity
    BEFORE UPDATE ON identity.device_challenges
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at');

-- Consommation unique et définitive (générique pour les tables de défis).
CREATE FUNCTION identity.challenge_consume_once()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = format('%I.%I : défi déjà consommé', TG_TABLE_SCHEMA, TG_TABLE_NAME);
    END IF;
    IF NEW.consumed_at IS NOT NULL AND NEW.consumed_at > OLD.expires_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = format('%I.%I : défi expiré', TG_TABLE_SCHEMA, TG_TABLE_NAME);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER device_challenges_consume_once
    BEFORE UPDATE ON identity.device_challenges
    FOR EACH ROW EXECUTE FUNCTION identity.challenge_consume_once();

-- -----------------------------------------------------------------------------
-- Défis de connexion : créés après vérification du mot de passe, ils portent
-- le second facteur attendu (code SMS ou TOTP) et, pour un nouvel appareil
-- mobile, l'enregistrement d'appareil déjà attesté, créé à la validation.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.login_challenges (
    id                  uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid                        NOT NULL REFERENCES identity.users (id),
    audience            identity.session_audience   NOT NULL,
    method              text                        NOT NULL,
    otp_challenge_id    uuid                        UNIQUE REFERENCES identity.otp_challenges (id),
    -- Appareil mobile déjà connu (signature de requête vérifiée à l'étape 1).
    device_id           uuid                        REFERENCES identity.devices (id),
    -- Nouvel appareil mobile attesté, enregistré à la validation du facteur.
    pending_device      jsonb,
    ip_address          inet,
    user_agent          text,
    attempts            smallint                    NOT NULL DEFAULT 0,
    max_attempts        smallint                    NOT NULL DEFAULT 5,
    created_at          timestamptz                 NOT NULL DEFAULT now(),
    expires_at          timestamptz                 NOT NULL,
    consumed_at         timestamptz,
    CONSTRAINT login_challenges_method CHECK (method IN ('sms_otp', 'totp')),
    CONSTRAINT login_challenges_otp_link CHECK ((method = 'sms_otp') = (otp_challenge_id IS NOT NULL)),
    -- Mobile : exactement un appareil (connu OU en cours d'enregistrement).
    CONSTRAINT login_challenges_mobile_device CHECK (
        audience <> 'mobile' OR ((device_id IS NOT NULL) <> (pending_device IS NOT NULL))
    ),
    CONSTRAINT login_challenges_web_no_device CHECK (
        audience <> 'web' OR (device_id IS NULL AND pending_device IS NULL)
    ),
    CONSTRAINT login_challenges_pending_object CHECK (pending_device IS NULL OR jsonb_typeof(pending_device) = 'object'),
    CONSTRAINT login_challenges_attempts CHECK (attempts >= 0 AND attempts <= max_attempts AND max_attempts BETWEEN 1 AND 10),
    CONSTRAINT login_challenges_expiry CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
    )
);

CREATE INDEX login_challenges_user_idx ON identity.login_challenges (user_id, created_at DESC);

CREATE TRIGGER login_challenges_freeze_identity
    BEFORE UPDATE ON identity.login_challenges
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('attempts', 'consumed_at');

CREATE FUNCTION identity.login_challenges_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'identity.login_challenges : défi déjà consommé';
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.login_challenges : le compteur de tentatives ne peut pas décroître';
    END IF;
    IF NEW.consumed_at IS NOT NULL AND NEW.consumed_at > OLD.expires_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'identity.login_challenges : défi expiré';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER login_challenges_guard
    BEFORE UPDATE ON identity.login_challenges
    FOR EACH ROW EXECUTE FUNCTION identity.login_challenges_guard();

CREATE TRIGGER login_challenges_forbid_delete
    BEFORE DELETE ON identity.login_challenges
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Défis WebAuthn (passkeys du site web client).
-- -----------------------------------------------------------------------------
CREATE TABLE identity.webauthn_challenges (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        REFERENCES identity.users (id),
    ceremony        text        NOT NULL,
    challenge       text        NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    CONSTRAINT webauthn_challenges_ceremony CHECK (ceremony IN ('registration', 'authentication')),
    CONSTRAINT webauthn_challenges_registration_user CHECK (ceremony <> 'registration' OR user_id IS NOT NULL),
    CONSTRAINT webauthn_challenges_format CHECK (challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
    CONSTRAINT webauthn_challenges_expiry CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
    )
);

CREATE TRIGGER webauthn_challenges_freeze_identity
    BEFORE UPDATE ON identity.webauthn_challenges
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at');
CREATE TRIGGER webauthn_challenges_consume_once
    BEFORE UPDATE ON identity.webauthn_challenges
    FOR EACH ROW EXECUTE FUNCTION identity.challenge_consume_once();

-- Le compteur de signature d'une passkey ne peut que croître (clonage).
CREATE FUNCTION identity.webauthn_credentials_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.sign_count < OLD.sign_count THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.webauthn_credentials : le compteur de signature ne peut pas décroître';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.webauthn_credentials : une révocation est définitive';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER webauthn_credentials_guard
    BEFORE UPDATE ON identity.webauthn_credentials
    FOR EACH ROW EXECUTE FUNCTION identity.webauthn_credentials_guard();

-- -----------------------------------------------------------------------------
-- Privilèges et RLS des nouvelles tables (même modèle que 0016).
-- -----------------------------------------------------------------------------
REVOKE ALL ON identity.device_challenges, identity.login_challenges, identity.webauthn_challenges FROM PUBLIC;
GRANT SELECT, INSERT ON identity.device_challenges, identity.login_challenges, identity.webauthn_challenges TO app_api;
GRANT UPDATE (consumed_at) ON identity.device_challenges, identity.webauthn_challenges TO app_api;
GRANT UPDATE (attempts, consumed_at) ON identity.login_challenges TO app_api;
GRANT EXECUTE ON FUNCTION identity.users_totp_step_guard(), identity.challenge_consume_once(),
                          identity.login_challenges_guard(), identity.webauthn_credentials_guard() TO app_api;
REVOKE EXECUTE ON FUNCTION identity.users_totp_step_guard(), identity.challenge_consume_once(),
                           identity.login_challenges_guard(), identity.webauthn_credentials_guard() FROM PUBLIC;

-- Les défis ne sont pas des données analytiques : aucun accès app_readonly.
REVOKE SELECT ON identity.device_challenges, identity.login_challenges, identity.webauthn_challenges FROM app_readonly;
GRANT SELECT (mfa_totp_last_used_step) ON identity.users TO app_readonly;

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['device_challenges', 'login_challenges', 'webauthn_challenges'] LOOP
        EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('CREATE POLICY app_api_all ON identity.%I FOR ALL TO app_api USING (true) WITH CHECK (true)', v_table);
    END LOOP;
END;
$$;

-- Purge des défis d'attestation et WebAuthn expirés depuis plus de 7 jours
-- (aucune valeur probante ; app_api n'a pas le droit DELETE). Les défis de
-- connexion sont conservés pour l'investigation des incidents.
CREATE FUNCTION identity.purge_expired_challenges()
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_total integer := 0;
    v_count integer;
BEGIN
    DELETE FROM identity.device_challenges WHERE expires_at < now() - interval '7 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;
    DELETE FROM identity.webauthn_challenges WHERE expires_at < now() - interval '7 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_total + v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION identity.purge_expired_challenges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.purge_expired_challenges() TO app_api;
