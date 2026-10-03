-- =============================================================================
-- 0013 — Intégrations : webhooks entrants, outbox, idempotence HTTP
--
-- Webhooks : l'API vérifie la signature cryptographique (Stripe-Signature,
-- verif-hash Flutterwave, HMAC Thunes/Smile ID/Onfido) AVANT toute écriture.
-- Seuls les événements authentifiés entrent dans webhook_events, une seule
-- fois par identifiant d'événement prestataire (déduplication des renvois).
-- Les requêtes rejetées sont tracées séparément pour la détection d'attaques.
--
-- Outbox : tout effet externe (appel prestataire, notification, e-mail) est
-- d'abord enregistré dans la même transaction que le changement d'état, puis
-- publié par un worker (SELECT ... FOR UPDATE SKIP LOCKED). Aucun effet n'est
-- perdu ni dupliqué si le processus tombe entre les deux.
-- =============================================================================

CREATE TABLE integrations.webhook_events (
    id                  uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
    source              integrations.webhook_source     NOT NULL,
    provider_event_id   text                            NOT NULL,
    event_type          text                            NOT NULL,
    -- Toujours vrai : un événement non authentifié n'est jamais stocké ici.
    signature_verified  boolean                         NOT NULL,
    -- Horodatage signé par le prestataire (protection anti-rejeu).
    signed_at           timestamptz,
    payload             jsonb                           NOT NULL,
    payload_sha256      bytea                           NOT NULL,
    status              integrations.webhook_status     NOT NULL DEFAULT 'received',
    attempts            integer                         NOT NULL DEFAULT 0,
    last_error          text,
    locked_until        timestamptz,
    received_at         timestamptz                     NOT NULL DEFAULT now(),
    processed_at        timestamptz,
    CONSTRAINT webhook_events_verified CHECK (signature_verified),
    CONSTRAINT webhook_events_unique UNIQUE (source, provider_event_id),
    CONSTRAINT webhook_events_sha256_len CHECK (octet_length(payload_sha256) = 32),
    CONSTRAINT webhook_events_attempts CHECK (attempts >= 0),
    CONSTRAINT webhook_events_processed_date CHECK (status NOT IN ('processed', 'ignored') OR processed_at IS NOT NULL)
);

CREATE INDEX webhook_events_queue_idx ON integrations.webhook_events (received_at)
    WHERE status IN ('received', 'failed');

CREATE TRIGGER webhook_events_freeze_identity
    BEFORE UPDATE ON integrations.webhook_events
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'attempts', 'last_error', 'locked_until', 'processed_at'
    );
CREATE TRIGGER webhook_events_forbid_delete
    BEFORE DELETE ON integrations.webhook_events
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Rejets (signature absente/invalide, horodatage hors tolérance...).
-- Le corps n'est conservé que sous forme d'empreinte et de taille.
CREATE TABLE integrations.webhook_rejections (
    id              bigint                                      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          text                                        NOT NULL,
    reason          integrations.webhook_rejection_reason       NOT NULL,
    ip_address      inet,
    user_agent      text,
    body_sha256     bytea                                       NOT NULL,
    body_size       integer                                     NOT NULL,
    received_at     timestamptz                                 NOT NULL DEFAULT now(),
    CONSTRAINT webhook_rejections_source_len CHECK (char_length(source) <= 50),
    CONSTRAINT webhook_rejections_sha256_len CHECK (octet_length(body_sha256) = 32),
    CONSTRAINT webhook_rejections_size CHECK (body_size >= 0)
);

CREATE INDEX webhook_rejections_received_idx ON integrations.webhook_rejections (received_at DESC);

CREATE TRIGGER webhook_rejections_immutable
    BEFORE UPDATE OR DELETE ON integrations.webhook_rejections
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Outbox transactionnelle.
-- -----------------------------------------------------------------------------
CREATE TABLE integrations.outbox (
    id              bigint                          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    aggregate_type  text                            NOT NULL,
    aggregate_id    uuid                            NOT NULL,
    event_type      text                            NOT NULL,
    payload         jsonb                           NOT NULL,
    -- Clé de déduplication côté consommateur.
    dedup_key       text                            NOT NULL UNIQUE,
    status          integrations.outbox_status      NOT NULL DEFAULT 'pending',
    attempts        integer                         NOT NULL DEFAULT 0,
    max_attempts    integer                         NOT NULL DEFAULT 20,
    available_at    timestamptz                     NOT NULL DEFAULT now(),
    locked_by       text,
    locked_until    timestamptz,
    last_error      text,
    created_at      timestamptz                     NOT NULL DEFAULT now(),
    published_at    timestamptz,
    CONSTRAINT outbox_attempts CHECK (attempts >= 0 AND attempts <= max_attempts),
    CONSTRAINT outbox_max_attempts CHECK (max_attempts BETWEEN 1 AND 100),
    CONSTRAINT outbox_aggregate_type_format CHECK (aggregate_type ~ '^[a-z_]{2,50}$'),
    CONSTRAINT outbox_event_type_format CHECK (event_type ~ '^[a-z_.]{2,100}$'),
    CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT outbox_published_date CHECK (status <> 'published' OR published_at IS NOT NULL),
    CONSTRAINT outbox_lock_pair CHECK ((locked_by IS NULL) = (locked_until IS NULL))
);

CREATE INDEX outbox_ready_idx ON integrations.outbox (available_at, id)
    WHERE status IN ('pending', 'failed');
CREATE INDEX outbox_aggregate_idx ON integrations.outbox (aggregate_type, aggregate_id);

CREATE TRIGGER outbox_freeze_identity
    BEFORE UPDATE ON integrations.outbox
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'attempts', 'available_at', 'locked_by', 'locked_until', 'last_error', 'published_at'
    );
CREATE TRIGGER outbox_forbid_delete
    BEFORE DELETE ON integrations.outbox
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Réservation atomique d'un lot de messages par un worker. Plusieurs workers
-- peuvent tourner en parallèle sans jamais traiter le même message. Un
-- message dont le bail a expiré (worker tombé) est repris. Le worker passe le
-- message en 'dead' lorsque attempts atteint max_attempts.
CREATE FUNCTION integrations.claim_outbox_batch(
    p_worker_id     text,
    p_batch_size    integer,
    p_lease         interval
)
    RETURNS SETOF integrations.outbox
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_batch_size NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'integrations.claim_outbox_batch : taille de lot 1..500';
    END IF;
    IF p_lease < interval '5 seconds' OR p_lease > interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'integrations.claim_outbox_batch : bail 5 s..15 min';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT o.id
          FROM integrations.outbox o
         WHERE o.attempts < o.max_attempts
           AND ((o.status IN ('pending', 'failed') AND o.available_at <= now())
                OR (o.status = 'processing' AND o.locked_until < now()))
         ORDER BY o.available_at, o.id
         LIMIT p_batch_size
           FOR UPDATE SKIP LOCKED
    )
    UPDATE integrations.outbox o
       SET status = 'processing',
           attempts = o.attempts + 1,
           locked_by = p_worker_id,
           locked_until = now() + p_lease
      FROM candidates c
     WHERE o.id = c.id
    RETURNING o.*;
END;
$$;

-- -----------------------------------------------------------------------------
-- Idempotence des requêtes HTTP mutatrices (en-tête Idempotency-Key) : la
-- même requête rejouée renvoie la même réponse ; une requête différente avec
-- la même clé est refusée (422).
-- -----------------------------------------------------------------------------
CREATE TABLE integrations.http_idempotency_keys (
    scope               text        NOT NULL,
    idempotency_key     text        NOT NULL,
    request_sha256      bytea       NOT NULL,
    response_status     smallint,
    response_body       jsonb,
    locked_until        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    expires_at          timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    PRIMARY KEY (scope, idempotency_key),
    CONSTRAINT http_idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9_\-]{16,128}$'),
    CONSTRAINT http_idempotency_scope_format CHECK (scope ~ '^[a-z]+:[0-9a-f\-]{36}$'),
    CONSTRAINT http_idempotency_sha256_len CHECK (octet_length(request_sha256) = 32),
    CONSTRAINT http_idempotency_completion CHECK ((completed_at IS NULL) = (response_status IS NULL)),
    CONSTRAINT http_idempotency_status_range CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599)
);

CREATE INDEX http_idempotency_expiry_idx ON integrations.http_idempotency_keys (expires_at);

CREATE TRIGGER http_idempotency_freeze_identity
    BEFORE UPDATE ON integrations.http_idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'response_status', 'response_body', 'locked_until', 'completed_at'
    );

-- Purge des clés expirées (seule suppression autorisée, via cette fonction).
CREATE FUNCTION integrations.purge_expired_idempotency_keys()
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM integrations.http_idempotency_keys k WHERE k.expires_at < now();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
