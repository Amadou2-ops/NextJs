-- =============================================================================
-- 0006 — Taux de change et devis
--
-- Convention de taux : 1 unité MAJEURE de la devise de base vaut "rate" unités
-- MAJEURES de la devise de cotation. Les fournisseurs (Fixer, Open Exchange
-- Rates) publient des taux contre USD ; un taux croisé EUR→XOF se calcule
-- comme rate(USD→XOF) / rate(USD→EUR).
--
-- Arrondi : la conversion d'un montant client arrondit toujours vers le bas
-- (le bénéficiaire ne reçoit jamais plus que ce que le taux annoncé permet,
-- et le reste ne crée jamais de monnaie à partir de rien).
-- =============================================================================

CREATE TABLE fx.rate_snapshots (
    id                  bigint              GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider            fx.rate_provider    NOT NULL,
    base_currency       char(3)             NOT NULL REFERENCES ref.currencies (code),
    quote_currency      char(3)             NOT NULL REFERENCES ref.currencies (code),
    rate                numeric(30, 15)     NOT NULL,
    provider_timestamp  timestamptz         NOT NULL,
    fetched_at          timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT rate_snapshots_positive CHECK (rate > 0),
    CONSTRAINT rate_snapshots_distinct_pair CHECK (base_currency <> quote_currency),
    CONSTRAINT rate_snapshots_not_future CHECK (provider_timestamp <= fetched_at + interval '5 minutes'),
    CONSTRAINT rate_snapshots_unique UNIQUE (provider, base_currency, quote_currency, provider_timestamp)
);

CREATE INDEX rate_snapshots_latest_idx
    ON fx.rate_snapshots (base_currency, quote_currency, provider_timestamp DESC);

CREATE TRIGGER rate_snapshots_immutable
    BEFORE UPDATE OR DELETE ON fx.rate_snapshots
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER rate_snapshots_no_truncate
    BEFORE TRUNCATE ON fx.rate_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- Dernier taux connu par fournisseur et par paire.
CREATE VIEW fx.latest_rates AS
SELECT DISTINCT ON (provider, base_currency, quote_currency)
       id, provider, base_currency, quote_currency, rate, provider_timestamp, fetched_at
  FROM fx.rate_snapshots
 ORDER BY provider, base_currency, quote_currency, provider_timestamp DESC, id DESC;

-- -----------------------------------------------------------------------------
-- Marges de change. La règle la plus spécifique et prioritaire s'applique.
-- -----------------------------------------------------------------------------
CREATE TABLE fx.pricing_rules (
    id                      uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    source_currency         char(3)         REFERENCES ref.currencies (code),
    destination_currency    char(3)         REFERENCES ref.currencies (code),
    margin_bps              integer         NOT NULL,
    priority                integer         NOT NULL DEFAULT 0,
    valid_from              timestamptz     NOT NULL DEFAULT now(),
    valid_to                timestamptz,
    created_by_admin_id     uuid,
    created_at              timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT pricing_rules_margin_range CHECK (margin_bps BETWEEN 0 AND 1500),
    CONSTRAINT pricing_rules_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX pricing_rules_lookup_idx
    ON fx.pricing_rules (source_currency, destination_currency, priority DESC);

-- Une règle publiée ne change plus : on la clôt (valid_to) et on en crée une
-- nouvelle, ce qui garde la trace du prix appliqué à chaque devis.
CREATE TRIGGER pricing_rules_freeze_identity
    BEFORE UPDATE ON fx.pricing_rules
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('valid_to');
CREATE TRIGGER pricing_rules_forbid_delete
    BEFORE DELETE ON fx.pricing_rules
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Conversion d'un montant en unités mineures, arrondie vers le bas.
--   convert_minor(10000 [100,00 EUR], 655.957, 'EUR', 'XOF') = 65595 XOF
-- -----------------------------------------------------------------------------
CREATE FUNCTION fx.convert_minor(
    p_amount_minor  bigint,
    p_rate          numeric,
    p_from          char(3),
    p_to            char(3)
)
    RETURNS bigint
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_from_units smallint := ref.currency_minor_units(p_from);
    v_to_units   smallint := ref.currency_minor_units(p_to);
BEGIN
    IF p_amount_minor IS NULL OR p_amount_minor < 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'fx.convert_minor : montant négatif ou absent';
    END IF;
    IF p_rate IS NULL OR p_rate <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'fx.convert_minor : taux invalide';
    END IF;
    RETURN floor(
        p_amount_minor::numeric * p_rate * power(10::numeric, (v_to_units - v_from_units)::numeric)
    )::bigint;
END;
$$;

-- -----------------------------------------------------------------------------
-- Devis : prix garanti au client pendant une durée courte. Un devis est
-- consommé au plus une fois, par un seul transfert, avant son expiration.
-- -----------------------------------------------------------------------------
CREATE TABLE fx.quotes (
    id                          uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     uuid            NOT NULL REFERENCES identity.users (id),
    source_country              char(2)         NOT NULL REFERENCES ref.countries (alpha2),
    destination_country         char(2)         NOT NULL REFERENCES ref.countries (alpha2),
    source_currency             char(3)         NOT NULL REFERENCES ref.currencies (code),
    destination_currency        char(3)         NOT NULL REFERENCES ref.currencies (code),
    payout_method               transfers.payout_method NOT NULL,
    -- Montant converti (hors frais), en unités mineures de la devise source.
    source_amount               bigint          NOT NULL,
    -- Frais facturés au client, en unités mineures de la devise source.
    fee_amount                  bigint          NOT NULL,
    -- Total débité au client = source_amount + fee_amount.
    total_debit                 bigint          NOT NULL,
    -- Montant reçu par le bénéficiaire, unités mineures de la devise cible.
    destination_amount          bigint          NOT NULL,
    mid_rate                    numeric(30, 15) NOT NULL,
    customer_rate               numeric(30, 15) NOT NULL,
    margin_bps                  integer         NOT NULL,
    pricing_rule_id             uuid            REFERENCES fx.pricing_rules (id),
    -- Jambes USD→source et USD→destination utilisées pour le taux croisé
    -- (NULL lorsque la devise est USD elle-même ou que source = destination).
    source_leg_snapshot_id      bigint          REFERENCES fx.rate_snapshots (id),
    destination_leg_snapshot_id bigint          REFERENCES fx.rate_snapshots (id),
    -- Équivalent USD (unités mineures) servant aux plafonds KYC et à l'AML.
    usd_equivalent              bigint          NOT NULL,
    created_at                  timestamptz     NOT NULL DEFAULT now(),
    expires_at                  timestamptz     NOT NULL,
    consumed_at                 timestamptz,
    consumed_by_transfer_id     uuid,
    CONSTRAINT quotes_amounts_positive CHECK (
        source_amount > 0 AND destination_amount > 0 AND fee_amount >= 0 AND usd_equivalent >= 0
    ),
    CONSTRAINT quotes_total_debit CHECK (total_debit = source_amount + fee_amount),
    CONSTRAINT quotes_rates_positive CHECK (mid_rate > 0 AND customer_rate > 0),
    CONSTRAINT quotes_margin_range CHECK (margin_bps BETWEEN 0 AND 1500),
    CONSTRAINT quotes_customer_rate_not_above_mid CHECK (customer_rate <= mid_rate),
    CONSTRAINT quotes_same_currency_par CHECK (
        source_currency <> destination_currency OR (mid_rate = 1 AND customer_rate = 1 AND margin_bps = 0)
    ),
    CONSTRAINT quotes_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
    CONSTRAINT quotes_consumption_pair CHECK ((consumed_at IS NULL) = (consumed_by_transfer_id IS NULL)),
    CONSTRAINT quotes_consumed_once UNIQUE (consumed_by_transfer_id)
);

CREATE INDEX quotes_user_idx ON fx.quotes (user_id, created_at DESC);

-- Vérifie à l'insertion que le devis est arithmétiquement cohérent : le taux
-- client découle exactement du taux moyen et de la marge, et le montant reçu
-- découle exactement du taux client. Aucune valeur incohérente ne peut être
-- présentée au client ni exécutée.
CREATE FUNCTION fx.quotes_validate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_expected_rate     numeric;
    v_expected_amount   bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_expected_rate := round(NEW.mid_rate * (10000 - NEW.margin_bps)::numeric / 10000, 15);
        IF NEW.customer_rate <> v_expected_rate THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('fx.quotes : taux client %s ≠ taux attendu %s', NEW.customer_rate, v_expected_rate);
        END IF;
        v_expected_amount := fx.convert_minor(NEW.source_amount, NEW.customer_rate,
                                              NEW.source_currency, NEW.destination_currency);
        IF NEW.destination_amount <> v_expected_amount THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('fx.quotes : montant reçu %s ≠ montant attendu %s',
                                 NEW.destination_amount, v_expected_amount);
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE : seule la consommation unique est permise.
    IF OLD.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'fx.quotes : devis déjà consommé';
    END IF;
    IF NEW.consumed_at IS NOT NULL AND NEW.consumed_at > OLD.expires_at THEN
        RAISE EXCEPTION USING ERRCODE = 'TR002', MESSAGE = 'fx.quotes : devis expiré';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER quotes_freeze_identity
    BEFORE UPDATE ON fx.quotes
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at', 'consumed_by_transfer_id');

CREATE TRIGGER quotes_validate
    BEFORE INSERT OR UPDATE ON fx.quotes
    FOR EACH ROW EXECUTE FUNCTION fx.quotes_validate();

CREATE TRIGGER quotes_forbid_delete
    BEFORE DELETE ON fx.quotes
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
