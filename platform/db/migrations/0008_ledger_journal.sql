-- =============================================================================
-- 0008 — Registre : journaux, écritures, tête de chaîne, ancrages
--
-- Un journal regroupe au moins deux écritures dont les débits et les crédits
-- s'équilibrent exactement pour chaque devise. Les journaux sont numérotés
-- par une séquence globale sans trou (seq) et chaînés : chaque journal porte
-- l'empreinte SHA-256 du précédent (prev_hash) et la sienne (hash), calculée
-- sur son contenu complet, écritures et soldes résultants compris. Modifier
-- une écriture passée casse la chaîne de manière détectable.
-- =============================================================================

CREATE TABLE ledger.journals (
    id                      uuid                    PRIMARY KEY,
    seq                     bigint                  NOT NULL UNIQUE,
    journal_type            ledger.journal_type     NOT NULL,
    idempotency_key         text                    NOT NULL UNIQUE,
    -- Empreinte de la requête d'origine : une même clé d'idempotence rejouée
    -- avec un contenu différent est rejetée (LG005).
    request_sha256          bytea                   NOT NULL,
    reference_type          text,
    reference_id            uuid,
    reverses_journal_id     uuid                    UNIQUE REFERENCES ledger.journals (id),
    description             text                    NOT NULL,
    metadata                jsonb                   NOT NULL DEFAULT '{}'::jsonb,
    actor                   text                    NOT NULL,
    effective_at            timestamptz             NOT NULL,
    created_at              timestamptz             NOT NULL DEFAULT clock_timestamp(),
    prev_hash               bytea                   NOT NULL,
    hash                    bytea                   NOT NULL UNIQUE,
    CONSTRAINT journals_seq_positive CHECK (seq > 0),
    CONSTRAINT journals_hash_len CHECK (octet_length(hash) = 32 AND octet_length(prev_hash) = 32),
    CONSTRAINT journals_request_hash_len CHECK (octet_length(request_sha256) = 32),
    CONSTRAINT journals_idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9:_.\-]{8,200}$'),
    CONSTRAINT journals_reversal_link CHECK ((journal_type = 'reversal') = (reverses_journal_id IS NOT NULL)),
    CONSTRAINT journals_no_self_reversal CHECK (reverses_journal_id IS DISTINCT FROM id),
    CONSTRAINT journals_reference_pair CHECK ((reference_type IS NULL) = (reference_id IS NULL)),
    CONSTRAINT journals_reference_type_format CHECK (reference_type IS NULL OR reference_type ~ '^[a-z_]{2,50}$'),
    CONSTRAINT journals_description_len CHECK (char_length(description) BETWEEN 1 AND 500),
    CONSTRAINT journals_actor_len CHECK (char_length(actor) BETWEEN 1 AND 200),
    CONSTRAINT journals_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX journals_reference_idx ON ledger.journals (reference_type, reference_id)
    WHERE reference_id IS NOT NULL;
CREATE INDEX journals_effective_at_idx ON ledger.journals (effective_at);

CREATE TABLE ledger.entries (
    id                  bigint                  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Clé étrangère différée : les écritures sont insérées avant l'en-tête du
    -- journal, dont l'empreinte est calculée à partir d'elles.
    journal_id          uuid                    NOT NULL,
    line_no             smallint                NOT NULL,
    account_id          uuid                    NOT NULL REFERENCES ledger.accounts (id),
    direction           ledger.entry_direction  NOT NULL,
    amount              bigint                  NOT NULL,
    currency            char(3)                 NOT NULL REFERENCES ref.currencies (code),
    -- Solde du compte immédiatement après cette écriture.
    balance_after       bigint                  NOT NULL,
    -- Numéro d'ordre de l'écriture dans le compte (1, 2, 3...).
    account_entry_seq   bigint                  NOT NULL,
    created_at          timestamptz             NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT entries_journal_fk FOREIGN KEY (journal_id) REFERENCES ledger.journals (id)
        DEFERRABLE INITIALLY DEFERRED,
    -- Plafond par ligne : 10^15 unités mineures (10 000 milliards en devise à
    -- 2 décimales), très en dessous de la limite de bigint (9,2 × 10^18) : la
    -- somme de 100 lignes ne peut pas déborder.
    CONSTRAINT entries_amount_range CHECK (amount > 0 AND amount <= 1000000000000000),
    CONSTRAINT entries_line_no_range CHECK (line_no BETWEEN 1 AND 100),
    CONSTRAINT entries_account_seq_positive CHECK (account_entry_seq > 0),
    CONSTRAINT entries_line_unique UNIQUE (journal_id, line_no),
    CONSTRAINT entries_account_seq_unique UNIQUE (account_id, account_entry_seq)
);

CREATE INDEX entries_journal_idx ON ledger.entries (journal_id);
-- Relevé de compte (historique paginé par numéro d'ordre).
CREATE INDEX entries_account_history_idx ON ledger.entries (account_id, account_entry_seq DESC);

-- -----------------------------------------------------------------------------
-- Tête de chaîne : ligne unique, verrouillée par chaque écriture comptable.
-- Elle sérialise l'attribution de seq et le chaînage des empreintes.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger.chain_head (
    singleton   boolean     PRIMARY KEY DEFAULT true,
    last_seq    bigint      NOT NULL,
    last_hash   bytea       NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chain_head_singleton CHECK (singleton),
    CONSTRAINT chain_head_seq_non_negative CHECK (last_seq >= 0),
    CONSTRAINT chain_head_hash_len CHECK (octet_length(last_hash) = 32)
);

-- Bloc de genèse : empreinte nulle de 32 octets.
INSERT INTO ledger.chain_head (singleton, last_seq, last_hash)
VALUES (true, 0, decode(repeat('00', 32), 'hex'));

-- -----------------------------------------------------------------------------
-- Ancrages externes : l'empreinte de tête est publiée périodiquement hors de
-- la base (stockage WORM, horodatage qualifié). Un administrateur de base qui
-- réécrirait l'historique ne pourrait pas réécrire ces ancrages.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger.chain_anchors (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seq                 bigint      NOT NULL,
    hash                bytea       NOT NULL,
    anchor_target       text        NOT NULL,
    external_reference  text        NOT NULL,
    anchored_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chain_anchors_seq_positive CHECK (seq > 0),
    CONSTRAINT chain_anchors_hash_len CHECK (octet_length(hash) = 32),
    CONSTRAINT chain_anchors_target_format CHECK (anchor_target ~ '^[a-z0-9_\-]{2,50}$'),
    CONSTRAINT chain_anchors_unique UNIQUE (anchor_target, seq)
);
