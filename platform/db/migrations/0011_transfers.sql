-- =============================================================================
-- 0011 — Transferts : bénéficiaires, barèmes de frais, transferts et machine
--        à états
--
-- La base garantit qu'un transfert reprend EXACTEMENT les montants d'un devis
-- valide du même client, consomme ce devis une seule fois, et ne change de
-- statut qu'en suivant le graphe de transitions autorisé. Chaque transition
-- est historisée automatiquement.
-- =============================================================================

CREATE TABLE transfers.recipients (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid                        NOT NULL REFERENCES identity.users (id),
    country                 char(2)                     NOT NULL REFERENCES ref.countries (alpha2),
    currency                char(3)                     NOT NULL REFERENCES ref.currencies (code),
    payout_method           transfers.payout_method     NOT NULL,
    full_name_enc           bytea                       NOT NULL,
    -- Coordonnées de paiement chiffrées (IBAN, numéro mobile money, etc.).
    account_details_enc     bytea                       NOT NULL,
    -- Index aveugle des coordonnées : détection des bénéficiaires partagés
    -- entre de nombreux expéditeurs (typologie de mule financière).
    account_details_bidx    bytea                       NOT NULL,
    -- Indice d'affichage non sensible (ex. « •••• 4821 », « Orange Money »).
    display_hint            text                        NOT NULL,
    bank_code               text,
    mobile_operator         text,
    relationship            text,
    pii_key_id              text                        NOT NULL,
    created_at              timestamptz                 NOT NULL DEFAULT now(),
    updated_at              timestamptz                 NOT NULL DEFAULT now(),
    archived_at             timestamptz,
    CONSTRAINT recipients_bidx_len CHECK (octet_length(account_details_bidx) = 32),
    CONSTRAINT recipients_display_hint_len CHECK (char_length(display_hint) BETWEEN 1 AND 64),
    CONSTRAINT recipients_mobile_operator CHECK (payout_method <> 'mobile_money' OR mobile_operator IS NOT NULL)
);

CREATE INDEX recipients_user_idx ON transfers.recipients (user_id) WHERE archived_at IS NULL;
CREATE INDEX recipients_bidx_idx ON transfers.recipients (account_details_bidx);
-- Un client n'enregistre pas deux fois le même bénéficiaire actif.
CREATE UNIQUE INDEX recipients_user_account_unique_idx
    ON transfers.recipients (user_id, account_details_bidx, payout_method)
    WHERE archived_at IS NULL;

CREATE TRIGGER recipients_set_updated_at
    BEFORE UPDATE ON transfers.recipients
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

-- Les coordonnées d'un bénéficiaire ne sont jamais modifiées sur place (un
-- transfert passé doit toujours pointer vers les coordonnées réellement
-- utilisées) : on archive et on en crée un nouveau.
CREATE TRIGGER recipients_freeze_identity
    BEFORE UPDATE ON transfers.recipients
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('relationship', 'updated_at', 'archived_at');

CREATE TRIGGER recipients_forbid_delete
    BEFORE DELETE ON transfers.recipients
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Barèmes de frais. Les colonnes NULL sont des jokers ; la règle la plus
-- prioritaire puis la plus spécifique s'applique. Montants en unités mineures
-- de la devise source.
-- -----------------------------------------------------------------------------
CREATE TABLE transfers.fee_schedules (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_country          char(2)                     REFERENCES ref.countries (alpha2),
    destination_country     char(2)                     REFERENCES ref.countries (alpha2),
    source_currency         char(3)                     NOT NULL REFERENCES ref.currencies (code),
    destination_currency    char(3)                     REFERENCES ref.currencies (code),
    payout_method           transfers.payout_method,
    funding_method          transfers.funding_method,
    fixed_fee               bigint                      NOT NULL DEFAULT 0,
    percentage_bps          integer                     NOT NULL DEFAULT 0,
    min_fee                 bigint                      NOT NULL DEFAULT 0,
    max_fee                 bigint,
    priority                integer                     NOT NULL DEFAULT 0,
    valid_from              timestamptz                 NOT NULL DEFAULT now(),
    valid_to                timestamptz,
    created_by_admin_id     uuid,
    created_at              timestamptz                 NOT NULL DEFAULT now(),
    CONSTRAINT fee_schedules_non_negative CHECK (fixed_fee >= 0 AND min_fee >= 0 AND (max_fee IS NULL OR max_fee >= min_fee)),
    CONSTRAINT fee_schedules_bps_range CHECK (percentage_bps BETWEEN 0 AND 1000),
    CONSTRAINT fee_schedules_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX fee_schedules_lookup_idx
    ON transfers.fee_schedules (source_currency, destination_country, priority DESC);

CREATE TRIGGER fee_schedules_freeze_identity
    BEFORE UPDATE ON transfers.fee_schedules
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('valid_to');
CREATE TRIGGER fee_schedules_forbid_delete
    BEFORE DELETE ON transfers.fee_schedules
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Calcul des frais d'un montant selon un barème (arrondi au supérieur sur la
-- part proportionnelle : les frais affichés ne sont jamais sous-estimés).
CREATE FUNCTION transfers.compute_fee(p_schedule_id uuid, p_amount bigint)
    RETURNS bigint
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_rule  record;
    v_fee   bigint;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers.compute_fee : montant invalide';
    END IF;
    SELECT f.fixed_fee, f.percentage_bps, f.min_fee, f.max_fee INTO v_rule
      FROM transfers.fee_schedules f WHERE f.id = p_schedule_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers.compute_fee : barème inconnu';
    END IF;
    v_fee := v_rule.fixed_fee + ceil(p_amount::numeric * v_rule.percentage_bps / 10000)::bigint;
    v_fee := GREATEST(v_fee, v_rule.min_fee);
    IF v_rule.max_fee IS NOT NULL THEN
        v_fee := LEAST(v_fee, v_rule.max_fee);
    END IF;
    RETURN v_fee;
END;
$$;

-- -----------------------------------------------------------------------------
-- Référence lisible : « TP » + 10 caractères sans ambiguïté visuelle
-- (pas de 0/O, 1/I/L), tirés d'un générateur cryptographique.
-- -----------------------------------------------------------------------------
CREATE FUNCTION transfers.generate_reference()
    RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_alphabet  constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    v_bytes     bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    v_result    text := 'TP';
    v_i         integer;
BEGIN
    FOR v_i IN 0..9 LOOP
        -- 31 symboles ; on rejette les octets ≥ 248 pour éviter le biais modulo.
        WHILE get_byte(v_bytes, v_i) >= 248 LOOP
            v_bytes := overlay(v_bytes PLACING uuid_send(gen_random_uuid()) FROM v_i + 1 FOR 16);
        END LOOP;
        v_result := v_result || substr(v_alphabet, (get_byte(v_bytes, v_i) % 31) + 1, 1);
    END LOOP;
    RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- Transferts.
-- -----------------------------------------------------------------------------
CREATE TABLE transfers.transfers (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    reference               text                        NOT NULL UNIQUE DEFAULT transfers.generate_reference(),
    user_id                 uuid                        NOT NULL REFERENCES identity.users (id),
    recipient_id            uuid                        NOT NULL REFERENCES transfers.recipients (id),
    quote_id                uuid                        NOT NULL UNIQUE REFERENCES fx.quotes (id),
    source_country          char(2)                     NOT NULL REFERENCES ref.countries (alpha2),
    destination_country     char(2)                     NOT NULL REFERENCES ref.countries (alpha2),
    source_currency         char(3)                     NOT NULL REFERENCES ref.currencies (code),
    destination_currency    char(3)                     NOT NULL REFERENCES ref.currencies (code),
    source_amount           bigint                      NOT NULL,
    fee_amount              bigint                      NOT NULL,
    total_debit             bigint                      NOT NULL,
    destination_amount      bigint                      NOT NULL,
    customer_rate           numeric(30, 15)             NOT NULL,
    usd_equivalent          bigint                      NOT NULL,
    funding_method          transfers.funding_method    NOT NULL,
    payout_method           transfers.payout_method     NOT NULL,
    status                  transfers.transfer_status   NOT NULL DEFAULT 'created',
    status_reason           text,
    purpose_code            text                        NOT NULL,
    -- Clé d'idempotence fournie par le client (en-tête Idempotency-Key).
    idempotency_key         text                        NOT NULL,
    -- Authentification renforcée ayant autorisé le transfert.
    authorization_method    text                        NOT NULL,
    authorized_at           timestamptz                 NOT NULL,
    authorized_device_id    uuid                        REFERENCES identity.devices (id),
    authorization_evidence  jsonb                       NOT NULL DEFAULT '{}'::jsonb,
    row_version             integer                     NOT NULL DEFAULT 1,
    created_at              timestamptz                 NOT NULL DEFAULT now(),
    updated_at              timestamptz                 NOT NULL DEFAULT now(),
    funded_at               timestamptz,
    completed_at            timestamptz,
    cancelled_at            timestamptz,
    refunded_at             timestamptz,
    CONSTRAINT transfers_idempotency_unique UNIQUE (user_id, idempotency_key),
    CONSTRAINT transfers_idempotency_format CHECK (idempotency_key ~ '^[A-Za-z0-9_\-]{16,128}$'),
    CONSTRAINT transfers_amounts_positive CHECK (
        source_amount > 0 AND destination_amount > 0 AND fee_amount >= 0 AND usd_equivalent >= 0
    ),
    CONSTRAINT transfers_total_debit CHECK (total_debit = source_amount + fee_amount),
    CONSTRAINT transfers_authorization_method CHECK (
        authorization_method IN ('device_signature', 'webauthn', 'totp', 'sms_otp')
    ),
    CONSTRAINT transfers_device_signature_needs_device CHECK (
        authorization_method <> 'device_signature' OR authorized_device_id IS NOT NULL
    ),
    CONSTRAINT transfers_purpose_format CHECK (purpose_code ~ '^[a-z_]{3,40}$'),
    CONSTRAINT transfers_evidence_object CHECK (jsonb_typeof(authorization_evidence) = 'object'),
    CONSTRAINT transfers_completed_date CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT transfers_refunded_date CHECK (status <> 'refunded' OR refunded_at IS NOT NULL),
    CONSTRAINT transfers_cancelled_date CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
    CONSTRAINT transfers_reference_format CHECK (reference ~ '^TP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$')
);

CREATE INDEX transfers_user_idx ON transfers.transfers (user_id, created_at DESC);
CREATE INDEX transfers_recipient_idx ON transfers.transfers (recipient_id);
CREATE INDEX transfers_status_idx ON transfers.transfers (status, updated_at)
    WHERE status NOT IN ('completed', 'cancelled', 'refunded');
-- Fenêtres de vélocité AML et plafonds KYC (cumul par client sur une période).
CREATE INDEX transfers_user_volume_idx ON transfers.transfers (user_id, created_at)
    INCLUDE (usd_equivalent, status);

CREATE TRIGGER transfers_set_updated_at
    BEFORE UPDATE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

CREATE TRIGGER transfers_freeze_identity
    BEFORE UPDATE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'status_reason', 'row_version', 'updated_at', 'funded_at',
        'completed_at', 'cancelled_at', 'refunded_at'
    );

CREATE TRIGGER transfers_forbid_delete
    BEFORE DELETE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Graphe des transitions autorisées.
-- -----------------------------------------------------------------------------
CREATE TABLE transfers.allowed_transitions (
    from_status transfers.transfer_status NOT NULL,
    to_status   transfers.transfer_status NOT NULL,
    PRIMARY KEY (from_status, to_status)
);

INSERT INTO transfers.allowed_transitions (from_status, to_status) VALUES
    -- Financement
    ('created',             'awaiting_funding'),
    ('created',             'funded'),              -- payé par le solde du portefeuille
    ('created',             'cancelled'),
    ('awaiting_funding',    'funding_processing'),
    ('awaiting_funding',    'cancelled'),
    ('funding_processing',  'funded'),
    ('funding_processing',  'cancelled'),           -- encaissement refusé
    -- Conformité et paiement
    ('funded',              'compliance_review'),
    ('funded',              'payout_pending'),
    ('funded',              'refund_pending'),
    ('compliance_review',   'payout_pending'),
    ('compliance_review',   'refund_pending'),
    ('payout_pending',      'payout_processing'),
    ('payout_pending',      'compliance_review'),
    ('payout_pending',      'refund_pending'),
    ('payout_processing',   'completed'),
    ('payout_processing',   'payout_failed'),
    ('payout_failed',       'payout_pending'),      -- nouvelle tentative, autre route
    ('payout_failed',       'refund_pending'),
    ('refund_pending',      'refunded');

CREATE TABLE transfers.status_history (
    id              bigint                      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id     uuid                        NOT NULL REFERENCES transfers.transfers (id),
    from_status     transfers.transfer_status,
    to_status       transfers.transfer_status   NOT NULL,
    reason          text,
    actor_type      transfers.actor_type        NOT NULL,
    actor_id        text,
    created_at      timestamptz                 NOT NULL DEFAULT now()
);

CREATE INDEX status_history_transfer_idx ON transfers.status_history (transfer_id, id);

CREATE TRIGGER status_history_immutable
    BEFORE UPDATE OR DELETE ON transfers.status_history
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER status_history_no_truncate
    BEFORE TRUNCATE ON transfers.status_history
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- -----------------------------------------------------------------------------
-- À l'insertion : cohérence stricte avec le devis et le bénéficiaire, puis
-- consommation du devis. À la mise à jour : transitions autorisées
-- uniquement, historisation, horodatages de fin.
-- L'acteur est fourni par l'API : SET LOCAL app.actor_type / app.actor_id /
-- app.change_note.
-- -----------------------------------------------------------------------------
CREATE FUNCTION transfers.transfers_guard()
    RETURNS trigger
    LANGUAGE plpgsql
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
            NEW.customer_rate, NEW.usd_equivalent, NEW.payout_method)
           IS DISTINCT FROM
           (v_quote.source_country, v_quote.destination_country, v_quote.source_currency, v_quote.destination_currency,
            v_quote.source_amount, v_quote.fee_amount, v_quote.total_debit, v_quote.destination_amount,
            v_quote.customer_rate, v_quote.usd_equivalent, v_quote.payout_method) THEN
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

CREATE TRIGGER transfers_guard
    BEFORE INSERT OR UPDATE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION transfers.transfers_guard();

-- Historisation après écriture (la ligne existe, la clé étrangère est valide).
CREATE FUNCTION transfers.transfers_record_history()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor_type    transfers.actor_type := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system')::transfers.actor_type;
    v_actor_id      text := NULLIF(current_setting('app.actor_id', true), '');
    v_note          text := COALESCE(NULLIF(current_setting('app.change_note', true), ''), NEW.status_reason);
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO transfers.status_history (transfer_id, from_status, to_status, reason, actor_type, actor_id)
        VALUES (NEW.id, NULL, NEW.status, v_note, v_actor_type, v_actor_id);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO transfers.status_history (transfer_id, from_status, to_status, reason, actor_type, actor_id)
        VALUES (NEW.id, OLD.status, NEW.status, v_note, v_actor_type, v_actor_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER transfers_record_history
    AFTER INSERT OR UPDATE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION transfers.transfers_record_history();

-- Lien retour du devis vers le transfert qui l'a consommé. Différé : le devis
-- est marqué consommé dans le trigger BEFORE INSERT du transfert, avant que
-- la ligne du transfert n'existe.
ALTER TABLE fx.quotes
    ADD CONSTRAINT quotes_consumed_by_transfer_fk
    FOREIGN KEY (consumed_by_transfer_id) REFERENCES transfers.transfers (id)
    DEFERRABLE INITIALLY DEFERRED;
