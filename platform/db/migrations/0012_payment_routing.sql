-- =============================================================================
-- 0012 — Paiements : prestataires, corridors, moteur de routage, tentatives
--
-- Le moteur de routage (API, phase 7) choisit pour chaque transfert la route
-- active la moins coûteuse parmi les corridors compatibles, en excluant les
-- prestataires dont le disjoncteur est ouvert. Chaque appel à un prestataire
-- est une « tentative » idempotente et traçable.
-- =============================================================================

CREATE TABLE payments.providers (
    code            payments.provider               PRIMARY KEY,
    display_name    text                            NOT NULL,
    environment     payments.provider_environment   NOT NULL,
    is_enabled      boolean                         NOT NULL DEFAULT false,
    supports_payin  boolean                         NOT NULL,
    supports_payout boolean                         NOT NULL,
    updated_at      timestamptz                     NOT NULL DEFAULT now()
);

-- Valeurs initiales en bac à sable : l'environnement « live » est activé par
-- une migration dédiée à la production, jamais par défaut.
INSERT INTO payments.providers (code, display_name, environment, is_enabled, supports_payin, supports_payout) VALUES
    ('stripe',      'Stripe Connect', 'sandbox', false, true,  true),
    ('flutterwave', 'Flutterwave',    'sandbox', false, true,  true),
    ('thunes',      'Thunes',         'sandbox', false, false, true);

CREATE TRIGGER providers_set_updated_at
    BEFORE UPDATE ON payments.providers
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER providers_freeze_identity
    BEFORE UPDATE ON payments.providers
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('display_name', 'environment', 'is_enabled', 'updated_at');
CREATE TRIGGER providers_forbid_delete
    BEFORE DELETE ON payments.providers
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Corridors de paiement sortant (payout) : pays d'origine × pays/devise de
-- destination × mode de paiement × prestataire. Montants bornés en unités
-- mineures de la devise de destination.
-- -----------------------------------------------------------------------------
CREATE TABLE payments.payout_corridors (
    id                          uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = tous pays d'origine ouverts à l'envoi.
    source_country              char(2)                     REFERENCES ref.countries (alpha2),
    destination_country         char(2)                     NOT NULL REFERENCES ref.countries (alpha2),
    destination_currency        char(3)                     NOT NULL REFERENCES ref.currencies (code),
    payout_method               transfers.payout_method     NOT NULL,
    provider                    payments.provider           NOT NULL REFERENCES payments.providers (code),
    priority                    integer                     NOT NULL DEFAULT 100,
    min_amount                  bigint                      NOT NULL,
    max_amount                  bigint                      NOT NULL,
    -- Coût prestataire estimé (pour le choix de la route la moins chère).
    cost_fixed                  bigint                      NOT NULL DEFAULT 0,
    cost_bps                    integer                     NOT NULL DEFAULT 0,
    estimated_delivery_minutes  integer                     NOT NULL,
    is_enabled                  boolean                     NOT NULL DEFAULT false,
    created_at                  timestamptz                 NOT NULL DEFAULT now(),
    updated_at                  timestamptz                 NOT NULL DEFAULT now(),
    CONSTRAINT payout_corridors_amounts CHECK (min_amount > 0 AND max_amount >= min_amount),
    CONSTRAINT payout_corridors_cost CHECK (cost_fixed >= 0 AND cost_bps BETWEEN 0 AND 1000),
    CONSTRAINT payout_corridors_delivery CHECK (estimated_delivery_minutes BETWEEN 0 AND 20160),
    CONSTRAINT payout_corridors_distinct_countries CHECK (source_country IS DISTINCT FROM destination_country OR source_country IS NULL)
);

-- NULLS NOT DISTINCT : une seule route « tous pays d'origine » par
-- combinaison (PostgreSQL ≥ 15).
CREATE UNIQUE INDEX payout_corridors_unique_idx
    ON payments.payout_corridors (source_country, destination_country, destination_currency, payout_method, provider)
    NULLS NOT DISTINCT;
CREATE INDEX payout_corridors_lookup_idx
    ON payments.payout_corridors (destination_country, destination_currency, payout_method)
    WHERE is_enabled;

CREATE TRIGGER payout_corridors_set_updated_at
    BEFORE UPDATE ON payments.payout_corridors
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER payout_corridors_forbid_delete
    BEFORE DELETE ON payments.payout_corridors
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Un corridor ne peut pas être activé vers un pays fermé ou interdit.
CREATE FUNCTION payments.payout_corridors_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_bad text;
BEGIN
    IF NEW.is_enabled THEN
        IF NOT EXISTS (SELECT 1 FROM ref.countries c WHERE c.alpha2 = NEW.destination_country AND c.can_receive) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('payments : le pays %s n''est pas ouvert à la réception', NEW.destination_country);
        END IF;
        IF NEW.source_country IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ref.countries c WHERE c.alpha2 = NEW.source_country AND c.can_send) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('payments : le pays %s n''est pas ouvert à l''envoi', NEW.source_country);
        END IF;
        SELECT p.code::text INTO v_bad FROM payments.providers p
         WHERE p.code = NEW.provider AND NOT p.supports_payout;
        IF FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('payments : %s ne gère pas les paiements sortants', v_bad);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payout_corridors_guard
    BEFORE INSERT OR UPDATE ON payments.payout_corridors
    FOR EACH ROW EXECUTE FUNCTION payments.payout_corridors_guard();

-- -----------------------------------------------------------------------------
-- Moyens d'encaissement (payin) par pays/devise d'origine.
-- -----------------------------------------------------------------------------
CREATE TABLE payments.payin_methods (
    id              uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    country         char(2)                     NOT NULL REFERENCES ref.countries (alpha2),
    currency        char(3)                     NOT NULL REFERENCES ref.currencies (code),
    funding_method  transfers.funding_method    NOT NULL,
    provider        payments.provider           NOT NULL REFERENCES payments.providers (code),
    priority        integer                     NOT NULL DEFAULT 100,
    min_amount      bigint                      NOT NULL,
    max_amount      bigint                      NOT NULL,
    cost_fixed      bigint                      NOT NULL DEFAULT 0,
    cost_bps        integer                     NOT NULL DEFAULT 0,
    is_enabled      boolean                     NOT NULL DEFAULT false,
    created_at      timestamptz                 NOT NULL DEFAULT now(),
    updated_at      timestamptz                 NOT NULL DEFAULT now(),
    CONSTRAINT payin_methods_amounts CHECK (min_amount > 0 AND max_amount >= min_amount),
    CONSTRAINT payin_methods_cost CHECK (cost_fixed >= 0 AND cost_bps BETWEEN 0 AND 1000),
    CONSTRAINT payin_methods_not_wallet CHECK (funding_method <> 'wallet_balance'),
    CONSTRAINT payin_methods_unique UNIQUE (country, currency, funding_method, provider)
);

CREATE TRIGGER payin_methods_set_updated_at
    BEFORE UPDATE ON payments.payin_methods
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER payin_methods_forbid_delete
    BEFORE DELETE ON payments.payin_methods
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION payments.payin_methods_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.is_enabled THEN
        IF NOT EXISTS (SELECT 1 FROM ref.countries c WHERE c.alpha2 = NEW.country AND c.can_send) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('payments : le pays %s n''est pas ouvert à l''envoi', NEW.country);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM payments.providers p WHERE p.code = NEW.provider AND p.supports_payin) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('payments : %s ne gère pas les encaissements', NEW.provider);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payin_methods_guard
    BEFORE INSERT OR UPDATE ON payments.payin_methods
    FOR EACH ROW EXECUTE FUNCTION payments.payin_methods_guard();

-- -----------------------------------------------------------------------------
-- Santé des prestataires (disjoncteur). Mise à jour par l'API après chaque
-- appel ; le moteur de routage ignore un prestataire « open ».
-- -----------------------------------------------------------------------------
CREATE TABLE payments.provider_health (
    provider            payments.provider       PRIMARY KEY REFERENCES payments.providers (code),
    circuit_state       payments.circuit_state  NOT NULL DEFAULT 'closed',
    window_started_at   timestamptz             NOT NULL DEFAULT now(),
    success_count       integer                 NOT NULL DEFAULT 0,
    failure_count       integer                 NOT NULL DEFAULT 0,
    consecutive_failures integer                NOT NULL DEFAULT 0,
    avg_latency_ms      integer                 NOT NULL DEFAULT 0,
    opened_at           timestamptz,
    next_probe_at       timestamptz,
    updated_at          timestamptz             NOT NULL DEFAULT now(),
    CONSTRAINT provider_health_counts CHECK (
        success_count >= 0 AND failure_count >= 0 AND consecutive_failures >= 0 AND avg_latency_ms >= 0
    ),
    CONSTRAINT provider_health_open_dates CHECK (
        circuit_state = 'closed' OR (opened_at IS NOT NULL AND next_probe_at IS NOT NULL)
    )
);

INSERT INTO payments.provider_health (provider) VALUES ('stripe'), ('flutterwave'), ('thunes');

CREATE TRIGGER provider_health_set_updated_at
    BEFORE UPDATE ON payments.provider_health
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

-- -----------------------------------------------------------------------------
-- Tentatives de paiement (une ligne par ordre envoyé à un prestataire).
-- -----------------------------------------------------------------------------
CREATE TABLE payments.attempts (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id             uuid                        NOT NULL REFERENCES transfers.transfers (id),
    direction               payments.payment_direction  NOT NULL,
    provider                payments.provider           NOT NULL REFERENCES payments.providers (code),
    corridor_id             uuid                        REFERENCES payments.payout_corridors (id),
    payin_method_id         uuid                        REFERENCES payments.payin_methods (id),
    -- Clé d'idempotence transmise au prestataire (Idempotency-Key Stripe,
    -- tx_ref Flutterwave, external_id Thunes).
    idempotency_key         text                        NOT NULL UNIQUE,
    provider_reference      text,
    amount                  bigint                      NOT NULL,
    currency                char(3)                     NOT NULL REFERENCES ref.currencies (code),
    status                  payments.attempt_status     NOT NULL DEFAULT 'pending',
    failure_code            text,
    failure_message         text,
    -- Réponse du prestataire expurgée de toute donnée personnelle ou secrète.
    provider_response       jsonb                       NOT NULL DEFAULT '{}'::jsonb,
    -- Journal comptable ayant constaté le résultat (règlement ou échec).
    ledger_journal_id       uuid                        REFERENCES ledger.journals (id),
    requested_at            timestamptz                 NOT NULL DEFAULT now(),
    completed_at            timestamptz,
    created_at              timestamptz                 NOT NULL DEFAULT now(),
    updated_at              timestamptz                 NOT NULL DEFAULT now(),
    CONSTRAINT attempts_amount_positive CHECK (amount > 0),
    CONSTRAINT attempts_provider_ref_unique UNIQUE (provider, provider_reference),
    CONSTRAINT attempts_route_link CHECK (
        (direction = 'payout' AND corridor_id IS NOT NULL AND payin_method_id IS NULL)
        OR (direction = 'payin' AND payin_method_id IS NOT NULL AND corridor_id IS NULL)
        OR (direction = 'refund' AND corridor_id IS NULL)
    ),
    CONSTRAINT attempts_failure_details CHECK (status <> 'failed' OR failure_code IS NOT NULL),
    CONSTRAINT attempts_terminal_date CHECK (
        status NOT IN ('succeeded', 'failed', 'cancelled', 'reversed') OR completed_at IS NOT NULL
    ),
    CONSTRAINT attempts_response_object CHECK (jsonb_typeof(provider_response) = 'object')
);

CREATE INDEX attempts_transfer_idx ON payments.attempts (transfer_id, created_at);
CREATE INDEX attempts_open_idx ON payments.attempts (provider, status, requested_at)
    WHERE status IN ('pending', 'requires_action', 'processing');
-- Une seule tentative en cours par transfert et par sens.
CREATE UNIQUE INDEX attempts_single_active_idx ON payments.attempts (transfer_id, direction)
    WHERE status IN ('pending', 'requires_action', 'processing');

CREATE TRIGGER attempts_set_updated_at
    BEFORE UPDATE ON payments.attempts
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER attempts_freeze_identity
    BEFORE UPDATE ON payments.attempts
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'provider_reference', 'status', 'failure_code', 'failure_message', 'provider_response',
        'ledger_journal_id', 'completed_at', 'updated_at'
    );
CREATE TRIGGER attempts_forbid_delete
    BEFORE DELETE ON payments.attempts
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE TABLE payments.attempt_transitions (
    from_status payments.attempt_status NOT NULL,
    to_status   payments.attempt_status NOT NULL,
    PRIMARY KEY (from_status, to_status)
);

INSERT INTO payments.attempt_transitions (from_status, to_status) VALUES
    ('pending',         'requires_action'),
    ('pending',         'processing'),
    ('pending',         'succeeded'),
    ('pending',         'failed'),
    ('pending',         'cancelled'),
    ('requires_action', 'processing'),
    ('requires_action', 'succeeded'),
    ('requires_action', 'failed'),
    ('requires_action', 'cancelled'),
    ('processing',      'succeeded'),
    ('processing',      'failed'),
    -- Rejet tardif par la banque du bénéficiaire ou rétrofacturation.
    ('succeeded',       'reversed');

CREATE FUNCTION payments.attempts_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
        SELECT 1 FROM payments.attempt_transitions t
         WHERE t.from_status = OLD.status AND t.to_status = NEW.status
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'PY001',
            MESSAGE = format('payments.attempts : transition %s → %s interdite', OLD.status, NEW.status);
    END IF;
    IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'payments.attempts : la référence prestataire est définitive une fois connue';
    END IF;
    IF OLD.ledger_journal_id IS NOT NULL AND NEW.ledger_journal_id IS DISTINCT FROM OLD.ledger_journal_id THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = 'payments.attempts : le journal comptable associé est définitif';
    END IF;
    IF NEW.status IN ('succeeded', 'failed', 'cancelled', 'reversed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.completed_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_guard
    BEFORE UPDATE ON payments.attempts
    FOR EACH ROW EXECUTE FUNCTION payments.attempts_guard();
