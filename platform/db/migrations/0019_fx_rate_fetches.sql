-- =============================================================================
-- 0019 — Change : journal des collectes de taux
--
-- Chaque appel à un fournisseur (Open Exchange Rates, Fixer) est tracé :
-- succès, échec, ou rejet par les contrôles de cohérence (variation anormale
-- depuis le dernier taux, divergence entre fournisseurs). Un taux rejeté
-- n'est jamais stocké dans fx.rate_snapshots, donc jamais proposé au client.
-- =============================================================================

CREATE TABLE fx.rate_fetches (
    id                  bigint              GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider            fx.rate_provider    NOT NULL,
    started_at          timestamptz         NOT NULL DEFAULT clock_timestamp(),
    finished_at         timestamptz         NOT NULL DEFAULT clock_timestamp(),
    status              text                NOT NULL,
    provider_timestamp  timestamptz,
    rates_received      integer             NOT NULL DEFAULT 0,
    rates_stored        integer             NOT NULL DEFAULT 0,
    -- Taux écartés par les contrôles : [{"currency":"XOF","reason":"...","rate":"..."}].
    rejected            jsonb               NOT NULL DEFAULT '[]'::jsonb,
    error_message       text,
    CONSTRAINT rate_fetches_status CHECK (status IN ('succeeded', 'partially_rejected', 'failed')),
    CONSTRAINT rate_fetches_counts CHECK (rates_received >= 0 AND rates_stored >= 0 AND rates_stored <= rates_received),
    CONSTRAINT rate_fetches_rejected_array CHECK (jsonb_typeof(rejected) = 'array'),
    CONSTRAINT rate_fetches_failure_message CHECK ((status = 'failed') = (error_message IS NOT NULL)),
    CONSTRAINT rate_fetches_partial CHECK (status <> 'partially_rejected' OR jsonb_array_length(rejected) > 0),
    CONSTRAINT rate_fetches_order CHECK (finished_at >= started_at)
);

CREATE INDEX rate_fetches_latest_idx ON fx.rate_fetches (provider, started_at DESC);

CREATE TRIGGER rate_fetches_immutable
    BEFORE UPDATE OR DELETE ON fx.rate_fetches
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

REVOKE ALL ON fx.rate_fetches FROM PUBLIC;
GRANT SELECT, INSERT ON fx.rate_fetches TO app_api;
GRANT SELECT ON fx.rate_fetches TO app_readonly;

ALTER TABLE fx.rate_fetches ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_api_all ON fx.rate_fetches FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_readonly_select ON fx.rate_fetches FOR SELECT TO app_readonly USING (true);

-- Dernier taux contre USD de chaque devise, tous fournisseurs confondus, avec
-- son âge (lecture rapide pour le moteur de devis).
CREATE VIEW fx.latest_usd_rates WITH (security_invoker = true) AS
SELECT DISTINCT ON (provider, quote_currency)
       id, provider, quote_currency AS currency, rate, provider_timestamp,
       now() - provider_timestamp AS age
  FROM fx.rate_snapshots
 WHERE base_currency = 'USD'
 ORDER BY provider, quote_currency, provider_timestamp DESC, id DESC;

GRANT SELECT ON fx.latest_usd_rates TO app_api, app_readonly;

-- -----------------------------------------------------------------------------
-- Le mode de financement fait partie du prix (barème de frais) : il est figé
-- dans le devis et le transfert doit le reprendre à l'identique.
-- -----------------------------------------------------------------------------
ALTER TABLE fx.quotes ADD COLUMN funding_method transfers.funding_method;
UPDATE fx.quotes SET funding_method = 'wallet_balance' WHERE funding_method IS NULL;
ALTER TABLE fx.quotes ALTER COLUMN funding_method SET NOT NULL;

-- Nouvelle version du contrôle d'insertion des transferts : identique à 0011,
-- avec en plus la concordance du mode de financement.
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

REVOKE EXECUTE ON FUNCTION transfers.transfers_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfers.transfers_guard() TO app_api;

-- -----------------------------------------------------------------------------
-- Correction du contrôle de cohérence des devis : la division numeric de
-- PostgreSQL arrondit son résultat à une échelle limitée (16 décimales ici)
-- AVANT le round(…, 15), soit un double arrondi qui pouvait refuser un taux
-- client exact (ex. 655,956521739130435 × 9850/10000 = …478,475 arrondi
-- d'abord à …4785 puis à …479). Le produit par 0.0001 est exact : un seul
-- arrondi, demi vers le haut, identique à applyMarginToRate côté API.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fx.quotes_validate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_expected_rate     numeric;
    v_expected_amount   bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_expected_rate := round(NEW.mid_rate * (10000 - NEW.margin_bps)::numeric * 0.0001, 15);
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
