-- =============================================================================
-- 0003 — Données de référence : devises (ISO 4217) et pays (ISO 3166-1)
--
-- Le contenu est chargé par db/seed/0001_currencies.sql et 0002_countries.sql
-- (générés par db/scripts/generate-reference-seed.ts). Par défaut, aucun pays
-- n'est ouvert à l'envoi ni à la réception : l'ouverture d'un pays est une
-- décision de conformité explicite.
-- =============================================================================

CREATE TABLE ref.currencies (
    code            char(3)     PRIMARY KEY,
    numeric_code    char(3)     NOT NULL UNIQUE,
    name            text        NOT NULL,
    -- Nombre de décimales de l'unité mineure (EUR = 2, JPY = 0, BHD = 3).
    -- Tous les montants de la plateforme sont des entiers dans cette unité.
    minor_units     smallint    NOT NULL,
    -- Devise ouverte commercialement (envoi ou réception).
    is_enabled      boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT currencies_code_format CHECK (code ~ '^[A-Z]{3}$'),
    CONSTRAINT currencies_numeric_format CHECK (numeric_code ~ '^[0-9]{3}$'),
    CONSTRAINT currencies_minor_units_range CHECK (minor_units BETWEEN 0 AND 4)
);

COMMENT ON COLUMN ref.currencies.minor_units IS
    'Exposant ISO 4217. 100,00 EUR est stocké 10000 ; 100 JPY est stocké 100.';

CREATE TRIGGER currencies_set_updated_at
    BEFORE UPDATE ON ref.currencies
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

-- L'exposant d'une devise ne peut jamais changer : tous les montants déjà
-- enregistrés deviendraient faux d'un facteur 10^n.
CREATE TRIGGER currencies_freeze_identity
    BEFORE UPDATE ON ref.currencies
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('name', 'is_enabled', 'updated_at');

CREATE TRIGGER currencies_forbid_delete
    BEFORE DELETE ON ref.currencies
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE TABLE ref.countries (
    alpha2              char(2)                 PRIMARY KEY,
    alpha3              char(3)                 NOT NULL UNIQUE,
    numeric_code        char(3)                 NOT NULL UNIQUE,
    name_en             text                    NOT NULL,
    name_fr             text                    NOT NULL,
    continent           ref.continent           NOT NULL,
    -- Indicatif téléphonique international sans le "+" (ex. "221").
    calling_code        text                    NOT NULL,
    default_currency    char(3)                 REFERENCES ref.currencies (code),
    risk_level          ref.country_risk_level  NOT NULL DEFAULT 'medium',
    can_send            boolean                 NOT NULL DEFAULT false,
    can_receive         boolean                 NOT NULL DEFAULT false,
    risk_reviewed_at    timestamptz,
    created_at          timestamptz             NOT NULL DEFAULT now(),
    updated_at          timestamptz             NOT NULL DEFAULT now(),
    CONSTRAINT countries_alpha2_format CHECK (alpha2 ~ '^[A-Z]{2}$'),
    CONSTRAINT countries_alpha3_format CHECK (alpha3 ~ '^[A-Z]{3}$'),
    CONSTRAINT countries_numeric_format CHECK (numeric_code ~ '^[0-9]{3}$'),
    CONSTRAINT countries_calling_code_format CHECK (calling_code ~ '^[0-9]{1,4}$'),
    -- Un pays interdit ne peut jamais être ouvert, quelle que soit l'erreur de
    -- configuration commise par un opérateur.
    CONSTRAINT countries_prohibited_closed CHECK (
        risk_level <> 'prohibited' OR (can_send = false AND can_receive = false)
    )
);

CREATE INDEX countries_default_currency_idx ON ref.countries (default_currency);

CREATE TRIGGER countries_set_updated_at
    BEFORE UPDATE ON ref.countries
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

CREATE TRIGGER countries_freeze_identity
    BEFORE UPDATE ON ref.countries
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'name_en', 'name_fr', 'calling_code', 'default_currency', 'risk_level',
        'can_send', 'can_receive', 'risk_reviewed_at', 'updated_at'
    );

CREATE TRIGGER countries_forbid_delete
    BEFORE DELETE ON ref.countries
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Exposant d'une devise ; lève une erreur si la devise est inconnue.
CREATE FUNCTION ref.currency_minor_units(p_code char(3))
    RETURNS smallint
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_units smallint;
BEGIN
    SELECT c.minor_units INTO v_units FROM ref.currencies c WHERE c.code = p_code;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = format('devise inconnue : %s', p_code);
    END IF;
    RETURN v_units;
END;
$$;
