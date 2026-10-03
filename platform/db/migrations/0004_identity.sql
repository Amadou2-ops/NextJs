-- =============================================================================
-- 0004 — Identité client : utilisateurs, appareils, sessions, jetons, OTP
--
-- Protection des données personnelles :
--   * Les champs *_enc sont chiffrés par l'API (AES-256-GCM, chiffrement
--     d'enveloppe avec une clé de données protégée par KMS). La base ne voit
--     jamais le clair. pii_key_id identifie la version de clé utilisée.
--   * Les champs *_bidx sont des index aveugles : HMAC-SHA-256 de la valeur
--     normalisée avec une clé secrète distincte. Ils permettent la recherche
--     exacte (connexion par téléphone, déduplication) sans stocker le clair.
--   * Aucun secret d'authentification n'est stocké en clair : mots de passe en
--     Argon2id, jetons de renouvellement et codes OTP sous forme d'empreinte.
-- =============================================================================

CREATE TABLE identity.users (
    id                      uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Numéro client lisible, communiqué au support (jamais l'UUID).
    customer_number         bigint                  GENERATED ALWAYS AS IDENTITY (START WITH 100000001) UNIQUE,
    status                  identity.user_status    NOT NULL DEFAULT 'pending_verification',

    phone_bidx              bytea                   NOT NULL UNIQUE,
    phone_enc               bytea                   NOT NULL,
    phone_country           char(2)                 NOT NULL REFERENCES ref.countries (alpha2),
    phone_verified_at       timestamptz,

    email_bidx              bytea                   UNIQUE,
    email_enc               bytea,
    email_verified_at       timestamptz,

    password_hash           text                    NOT NULL,
    password_changed_at     timestamptz             NOT NULL DEFAULT now(),

    first_name_enc          bytea,
    last_name_enc           bytea,
    date_of_birth_enc       bytea,
    address_enc             bytea,
    nationality             char(2)                 REFERENCES ref.countries (alpha2),
    country_of_residence    char(2)                 NOT NULL REFERENCES ref.countries (alpha2),
    pii_key_id              text                    NOT NULL,

    kyc_tier                kyc.kyc_tier            NOT NULL DEFAULT 'tier_0',
    preferred_locale        text                    NOT NULL DEFAULT 'fr',

    mfa_totp_secret_enc     bytea,
    mfa_totp_enabled_at     timestamptz,

    failed_login_count      integer                 NOT NULL DEFAULT 0,
    locked_until            timestamptz,
    last_login_at           timestamptz,

    row_version             integer                 NOT NULL DEFAULT 1,
    created_at              timestamptz             NOT NULL DEFAULT now(),
    updated_at              timestamptz             NOT NULL DEFAULT now(),
    suspended_at            timestamptz,
    closed_at               timestamptz,

    CONSTRAINT users_password_argon2id CHECK (password_hash LIKE '$argon2id$%'),
    CONSTRAINT users_phone_bidx_len CHECK (octet_length(phone_bidx) = 32),
    CONSTRAINT users_email_bidx_len CHECK (email_bidx IS NULL OR octet_length(email_bidx) = 32),
    CONSTRAINT users_email_pair CHECK ((email_bidx IS NULL) = (email_enc IS NULL)),
    CONSTRAINT users_failed_login_non_negative CHECK (failed_login_count >= 0),
    CONSTRAINT users_locale_format CHECK (preferred_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    CONSTRAINT users_mfa_pair CHECK (mfa_totp_enabled_at IS NULL OR mfa_totp_secret_enc IS NOT NULL),
    CONSTRAINT users_closed_consistency CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    CONSTRAINT users_active_requires_phone CHECK (status <> 'active' OR phone_verified_at IS NOT NULL)
);

CREATE INDEX users_status_idx ON identity.users (status);
CREATE INDEX users_country_of_residence_idx ON identity.users (country_of_residence);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

CREATE TRIGGER users_freeze_identity
    BEFORE UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'phone_bidx', 'phone_enc', 'phone_country', 'phone_verified_at',
        'email_bidx', 'email_enc', 'email_verified_at', 'password_hash',
        'password_changed_at', 'first_name_enc', 'last_name_enc', 'date_of_birth_enc',
        'address_enc', 'nationality', 'country_of_residence', 'pii_key_id', 'kyc_tier',
        'preferred_locale', 'mfa_totp_secret_enc', 'mfa_totp_enabled_at',
        'failed_login_count', 'locked_until', 'last_login_at', 'row_version',
        'updated_at', 'suspended_at', 'closed_at'
    );

-- Les comptes clients ne sont jamais supprimés physiquement (obligation de
-- conservation LCB-FT, 5 ans minimum). La clôture passe par status = 'closed'.
CREATE TRIGGER users_forbid_delete
    BEFORE DELETE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Appareils de confiance. Chaque installation mobile génère une paire de clés
-- dans l'enclave sécurisée (Secure Enclave / StrongBox) ; la clé publique est
-- enregistrée ici et sert à vérifier la signature des requêtes sensibles.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.devices (
    id                          uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     uuid                            NOT NULL REFERENCES identity.users (id),
    platform                    identity.device_platform        NOT NULL,
    device_name                 text                            NOT NULL,
    app_version                 text,
    os_version                  text,
    -- Clé publique au format SubjectPublicKeyInfo (DER).
    public_key_spki             bytea                           NOT NULL,
    public_key_algorithm        identity.device_key_algorithm   NOT NULL,
    public_key_sha256           bytea                           GENERATED ALWAYS AS (sha256(public_key_spki)) STORED,
    attestation_type            identity.attestation_type       NOT NULL,
    attestation_verified_at     timestamptz,
    -- Compteur anti-rejeu de la signature des requêtes.
    signature_counter           bigint                          NOT NULL DEFAULT 0,
    push_token_enc              bytea,
    trusted_at                  timestamptz,
    last_seen_at                timestamptz,
    revoked_at                  timestamptz,
    revoked_reason              text,
    created_at                  timestamptz                     NOT NULL DEFAULT now(),
    updated_at                  timestamptz                     NOT NULL DEFAULT now(),
    CONSTRAINT devices_public_key_unique UNIQUE (public_key_sha256),
    CONSTRAINT devices_attestation_mobile CHECK (
        platform = 'web' OR attestation_type <> 'none'
    ),
    CONSTRAINT devices_trusted_requires_attestation CHECK (
        trusted_at IS NULL OR attestation_type = 'none' OR attestation_verified_at IS NOT NULL
    ),
    CONSTRAINT devices_counter_non_negative CHECK (signature_counter >= 0),
    CONSTRAINT devices_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX devices_user_active_idx ON identity.devices (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER devices_set_updated_at
    BEFORE UPDATE ON identity.devices
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

-- public_key_sha256 est une colonne générée (NULL dans NEW au moment d'un
-- trigger BEFORE) dérivée de public_key_spki, lui-même figé.
CREATE TRIGGER devices_freeze_identity
    BEFORE UPDATE ON identity.devices
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'public_key_sha256', 'device_name', 'app_version', 'os_version', 'attestation_verified_at',
        'signature_counter', 'push_token_enc', 'trusted_at', 'last_seen_at',
        'revoked_at', 'revoked_reason', 'updated_at'
    );

-- Le compteur de signature ne peut que croître (protection anti-rejeu) et une
-- révocation est définitive.
CREATE FUNCTION identity.devices_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.signature_counter < OLD.signature_counter THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.devices : le compteur de signature ne peut pas décroître';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.devices : une révocation est définitive';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER devices_guard
    BEFORE UPDATE ON identity.devices
    FOR EACH ROW EXECUTE FUNCTION identity.devices_guard();

CREATE TRIGGER devices_forbid_delete
    BEFORE DELETE ON identity.devices
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Clés d'accès WebAuthn (passkeys) des clients sur le site web.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.webauthn_credentials (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES identity.users (id),
    credential_id       bytea       NOT NULL UNIQUE,
    public_key_cose     bytea       NOT NULL,
    sign_count          bigint      NOT NULL DEFAULT 0,
    transports          text[]      NOT NULL DEFAULT '{}',
    aaguid              uuid,
    backup_eligible     boolean     NOT NULL DEFAULT false,
    backup_state        boolean     NOT NULL DEFAULT false,
    nickname            text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    revoked_at          timestamptz,
    CONSTRAINT webauthn_sign_count_non_negative CHECK (sign_count >= 0)
);

CREATE INDEX webauthn_credentials_user_idx ON identity.webauthn_credentials (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER webauthn_credentials_freeze_identity
    BEFORE UPDATE ON identity.webauthn_credentials
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'sign_count', 'backup_state', 'nickname', 'last_used_at', 'revoked_at'
    );

CREATE TRIGGER webauthn_credentials_forbid_delete
    BEFORE DELETE ON identity.webauthn_credentials
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Sessions. L'identifiant de session est porté par le claim "sid" du JWT
-- d'accès ; sa révocation invalide immédiatement tous les jetons émis.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.sessions (
    id                  uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid                        NOT NULL REFERENCES identity.users (id),
    device_id           uuid                        REFERENCES identity.devices (id),
    audience            identity.session_audience   NOT NULL,
    -- Niveau d'assurance : 1 = un facteur, 2 = deux facteurs vérifiés.
    assurance_level     smallint                    NOT NULL DEFAULT 1,
    ip_address          inet,
    user_agent          text,
    created_at          timestamptz                 NOT NULL DEFAULT now(),
    last_used_at        timestamptz                 NOT NULL DEFAULT now(),
    idle_expires_at     timestamptz                 NOT NULL,
    absolute_expires_at timestamptz                 NOT NULL,
    mfa_verified_at     timestamptz,
    revoked_at          timestamptz,
    revoked_reason      text,
    CONSTRAINT sessions_assurance_range CHECK (assurance_level IN (1, 2)),
    CONSTRAINT sessions_mobile_requires_device CHECK (audience <> 'mobile' OR device_id IS NOT NULL),
    CONSTRAINT sessions_expiry_order CHECK (
        idle_expires_at > created_at AND absolute_expires_at > created_at
        AND idle_expires_at <= absolute_expires_at
    ),
    CONSTRAINT sessions_aal2_requires_mfa CHECK (assurance_level = 1 OR mfa_verified_at IS NOT NULL),
    CONSTRAINT sessions_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX sessions_user_active_idx ON identity.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_device_idx ON identity.sessions (device_id) WHERE device_id IS NOT NULL;

CREATE TRIGGER sessions_freeze_identity
    BEFORE UPDATE ON identity.sessions
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'assurance_level', 'last_used_at', 'idle_expires_at', 'mfa_verified_at',
        'revoked_at', 'revoked_reason'
    );

CREATE FUNCTION identity.sessions_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL AND (
        NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
        OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.sessions : une session révoquée ne peut pas être prolongée';
    END IF;
    IF NEW.idle_expires_at > OLD.absolute_expires_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.sessions : l''expiration d''inactivité dépasse l''expiration absolue';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_guard
    BEFORE UPDATE ON identity.sessions
    FOR EACH ROW EXECUTE FUNCTION identity.sessions_guard();

CREATE TRIGGER sessions_forbid_delete
    BEFORE DELETE ON identity.sessions
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Jetons de renouvellement opaques, en rotation. Seule l'empreinte SHA-256 du
-- jeton est stockée. Tous les jetons issus d'une même connexion partagent un
-- family_id : la réutilisation d'un jeton déjà consommé révoque la famille.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.refresh_tokens (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid        NOT NULL REFERENCES identity.sessions (id),
    family_id       uuid        NOT NULL,
    parent_id       uuid        REFERENCES identity.refresh_tokens (id),
    token_sha256    bytea       NOT NULL UNIQUE,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    revoked_at      timestamptz,
    revoked_reason  text,
    CONSTRAINT refresh_tokens_hash_len CHECK (octet_length(token_sha256) = 32),
    CONSTRAINT refresh_tokens_expiry CHECK (expires_at > issued_at),
    CONSTRAINT refresh_tokens_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- Un jeton parent ne peut avoir qu'un seul successeur : deux renouvellements
-- concurrents avec le même jeton ne peuvent pas réussir tous les deux.
CREATE UNIQUE INDEX refresh_tokens_single_child_idx ON identity.refresh_tokens (parent_id)
    WHERE parent_id IS NOT NULL;
CREATE INDEX refresh_tokens_family_idx ON identity.refresh_tokens (family_id);
CREATE INDEX refresh_tokens_session_idx ON identity.refresh_tokens (session_id);

CREATE TRIGGER refresh_tokens_freeze_identity
    BEFORE UPDATE ON identity.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at', 'revoked_at', 'revoked_reason');

CREATE FUNCTION identity.refresh_tokens_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.refresh_tokens : un jeton consommé ne peut pas être réutilisé';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.refresh_tokens : une révocation est définitive';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER refresh_tokens_guard
    BEFORE UPDATE ON identity.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION identity.refresh_tokens_guard();

CREATE TRIGGER refresh_tokens_forbid_delete
    BEFORE DELETE ON identity.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Révoque toute une famille de jetons et la session associée (détection de
-- réutilisation d'un jeton volé). Retourne le nombre de jetons révoqués.
CREATE FUNCTION identity.revoke_refresh_token_family(p_family_id uuid, p_reason text)
    RETURNS integer
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE identity.refresh_tokens
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE family_id = p_family_id
       AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE identity.sessions s
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE s.revoked_at IS NULL
       AND s.id IN (SELECT rt.session_id FROM identity.refresh_tokens rt WHERE rt.family_id = p_family_id);

    RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- Défis OTP (SMS, e-mail, WhatsApp). Le code n'est stocké que sous forme
-- d'empreinte HMAC ; le nombre de tentatives est borné.
-- -----------------------------------------------------------------------------
CREATE TABLE identity.otp_challenges (
    id                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid                    REFERENCES identity.users (id),
    purpose             identity.otp_purpose    NOT NULL,
    channel             identity.otp_channel    NOT NULL,
    destination_bidx    bytea                   NOT NULL,
    code_hmac           bytea                   NOT NULL,
    attempts            smallint                NOT NULL DEFAULT 0,
    max_attempts        smallint                NOT NULL DEFAULT 5,
    ip_address          inet,
    created_at          timestamptz             NOT NULL DEFAULT now(),
    expires_at          timestamptz             NOT NULL,
    consumed_at         timestamptz,
    CONSTRAINT otp_code_hmac_len CHECK (octet_length(code_hmac) = 32),
    CONSTRAINT otp_attempts_range CHECK (attempts >= 0 AND attempts <= max_attempts),
    CONSTRAINT otp_max_attempts_range CHECK (max_attempts BETWEEN 1 AND 10),
    CONSTRAINT otp_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);

CREATE INDEX otp_challenges_destination_idx ON identity.otp_challenges (destination_bidx, created_at DESC);
CREATE INDEX otp_challenges_user_idx ON identity.otp_challenges (user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE TRIGGER otp_challenges_freeze_identity
    BEFORE UPDATE ON identity.otp_challenges
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('attempts', 'consumed_at');

CREATE FUNCTION identity.otp_challenges_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.otp_challenges : le compteur de tentatives ne peut pas décroître';
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'identity.otp_challenges : un défi consommé est définitif';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER otp_challenges_guard
    BEFORE UPDATE ON identity.otp_challenges
    FOR EACH ROW EXECUTE FUNCTION identity.otp_challenges_guard();
