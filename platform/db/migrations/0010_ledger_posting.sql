-- =============================================================================
-- 0010 — Registre : ouverture de comptes, passation d'écritures,
--        contre-passation, vérifications d'intégrité
--
-- ledger.post_journal() est l'UNIQUE point d'entrée pour modifier un solde.
-- Algorithme (une seule transaction, niveau READ COMMITTED ou supérieur) :
--   1. Validation stricte des entrées (montants entiers > 0, sens, devises).
--   2. Idempotence : même clé + même contenu → renvoie le journal existant ;
--      même clé + contenu différent → LG005.
--   3. Verrouillage des lignes de solde par SELECT ... FOR UPDATE, toujours
--      dans l'ordre croissant des identifiants de compte (aucun interblocage
--      possible entre deux écritures concurrentes).
--   4. Contrôles : comptes actifs, devise du compte, équilibre par devise,
--      provision suffisante.
--   5. Verrouillage de la tête de chaîne, attribution de seq, application des
--      écritures et des soldes, calcul de l'empreinte chaînée.
-- =============================================================================

-- Préfixe de longueur pour une sérialisation sans ambiguïté : aucun contenu de
-- champ ne peut se faire passer pour un séparateur.
CREATE FUNCTION ledger.lp(p_value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE WHEN p_value IS NULL THEN '-1:'
                ELSE octet_length(convert_to(p_value, 'UTF8'))::text || ':' || p_value
           END;
$$;

-- Représentation canonique (version 1) d'un journal et de ses écritures.
CREATE FUNCTION ledger.canonical_payload(
    p_journal_id            uuid,
    p_seq                   bigint,
    p_journal_type          ledger.journal_type,
    p_idempotency_key       text,
    p_reference_type        text,
    p_reference_id          uuid,
    p_reverses_journal_id   uuid,
    p_description           text,
    p_metadata              jsonb,
    p_actor                 text,
    p_effective_at          timestamptz
)
    RETURNS text
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT ledger.lp('v1')
        || ledger.lp(p_journal_id::text)
        || ledger.lp(p_seq::text)
        || ledger.lp(p_journal_type::text)
        || ledger.lp(p_idempotency_key)
        || ledger.lp(p_reference_type)
        || ledger.lp(p_reference_id::text)
        || ledger.lp(p_reverses_journal_id::text)
        || ledger.lp(p_description)
        || ledger.lp(p_metadata::text)
        || ledger.lp(p_actor)
        || ledger.lp(((extract(epoch FROM p_effective_at) * 1000000)::bigint)::text)
        || ledger.lp((
            SELECT string_agg(
                       ledger.lp(e.line_no::text)
                    || ledger.lp(e.account_id::text)
                    || ledger.lp(e.direction::text)
                    || ledger.lp(e.amount::text)
                    || ledger.lp(e.currency::text)
                    || ledger.lp(e.balance_after::text)
                    || ledger.lp(e.account_entry_seq::text),
                       '' ORDER BY e.line_no)
              FROM ledger.entries e
             WHERE e.journal_id = p_journal_id
        ));
$$;

CREATE FUNCTION ledger.chain_hash(p_prev_hash bytea, p_payload text)
    RETURNS bytea
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT sha256(p_prev_hash || convert_to(p_payload, 'UTF8'));
$$;

-- -----------------------------------------------------------------------------
-- Ouverture de comptes (idempotente : renvoie le compte existant).
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger.open_customer_account(
    p_user_id       uuid,
    p_account_type  ledger.account_type,
    p_currency      char(3)
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id    uuid;
    v_code  text;
BEGIN
    IF p_account_type NOT IN ('customer_wallet', 'customer_hold') THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger.open_customer_account : type %s non client', p_account_type);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id AND u.status <> 'closed') THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'ledger.open_customer_account : client inconnu ou clôturé';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ref.currencies c WHERE c.code = p_currency AND c.is_enabled) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger.open_customer_account : devise %s inconnue ou non ouverte', p_currency);
    END IF;

    v_code := format('customer:%s:%s:%s', p_user_id, p_account_type, p_currency);

    INSERT INTO ledger.accounts (code, account_type, normal_side, currency, owner_user_id, allow_negative, name)
    VALUES (v_code, p_account_type, 'credit', p_currency, p_user_id, false,
            format('%s %s', CASE p_account_type WHEN 'customer_wallet' THEN 'Portefeuille' ELSE 'Fonds réservés' END, p_currency))
    ON CONFLICT (code) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT a.id INTO STRICT v_id FROM ledger.accounts a WHERE a.code = v_code;
    END IF;
    RETURN v_id;
END;
$$;

CREATE FUNCTION ledger.open_system_account(
    p_account_type  ledger.account_type,
    p_currency      char(3),
    p_provider      payments.provider DEFAULT NULL
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id            uuid;
    v_code          text;
    v_normal_side   ledger.normal_side;
    v_allow_neg     boolean;
BEGIN
    IF p_account_type IN ('customer_wallet', 'customer_hold') THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'ledger.open_system_account : utiliser open_customer_account pour un compte client';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ref.currencies c WHERE c.code = p_currency) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger.open_system_account : devise %s inconnue', p_currency);
    END IF;

    v_normal_side := CASE
        WHEN p_account_type IN ('payout_clearing', 'fee_revenue', 'fx_revenue', 'equity') THEN 'credit'
        ELSE 'debit'
    END;
    v_allow_neg := p_account_type IN ('fx_position', 'suspense', 'equity');

    v_code := CASE
        WHEN p_provider IS NULL THEN format('system:%s:%s', p_account_type, p_currency)
        ELSE format('provider:%s:%s:%s', p_provider, p_account_type, p_currency)
    END;

    INSERT INTO ledger.accounts (code, account_type, normal_side, currency, provider, allow_negative, name)
    VALUES (v_code, p_account_type, v_normal_side, p_currency, p_provider, v_allow_neg,
            initcap(replace(p_account_type::text, '_', ' ')) || ' ' || p_currency
                || COALESCE(' (' || p_provider::text || ')', ''))
    ON CONFLICT (code) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT a.id INTO STRICT v_id FROM ledger.accounts a WHERE a.code = v_code;
    END IF;
    RETURN v_id;
END;
$$;

-- Gel / dégel / clôture d'un compte (conformité, saisie judiciaire...).
CREATE FUNCTION ledger.set_account_status(
    p_account_id    uuid,
    p_status        ledger.account_status,
    p_reason        text
)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_status <> 'active' AND (p_reason IS NULL OR char_length(btrim(p_reason)) < 5) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'ledger.set_account_status : un motif explicite (≥ 5 caractères) est obligatoire';
    END IF;

    UPDATE ledger.accounts a
       SET status        = p_status,
           status_reason = CASE WHEN p_status = 'active' THEN NULL ELSE p_reason END,
           frozen_at     = CASE WHEN p_status = 'frozen' THEN now()
                                WHEN p_status = 'active' THEN NULL
                                ELSE a.frozen_at END,
           closed_at     = CASE WHEN p_status = 'closed' THEN now() ELSE a.closed_at END
     WHERE a.id = p_account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger.set_account_status : compte inconnu';
    END IF;
END;
$$;

-- Ligne d'écriture normalisée, avant application. Un tableau de ce type est
-- utilisé à la place d'une table temporaire : dans une fonction SECURITY
-- DEFINER, une table temporaire préexistante créée par l'appelant (avec ses
-- propres triggers) permettrait une élévation de privilèges.
CREATE TYPE ledger.pending_entry AS (
    line_no     smallint,
    account_id  uuid,
    direction   ledger.entry_direction,
    amount      bigint,
    currency    char(3)
);

-- -----------------------------------------------------------------------------
-- Cœur : passation d'un journal. Fonction interne, non exposée au rôle
-- applicatif (seules post_journal et reverse_journal l'appellent).
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger._post_journal(
    p_idempotency_key       text,
    p_journal_type          ledger.journal_type,
    p_entries               jsonb,
    p_description           text,
    p_actor                 text,
    p_reference_type        text,
    p_reference_id          uuid,
    p_metadata              jsonb,
    p_effective_at          timestamptz,
    p_reverses_journal_id   uuid
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET lock_timeout = '5s'
AS $$
DECLARE
    v_entry_count       integer;
    v_lines             ledger.pending_entry[];
    v_request_text      text;
    v_request_sha256    bytea;
    v_existing          record;
    v_bad               record;
    v_account_ids       uuid[];
    v_locked_count      integer;
    v_head              record;
    v_journal_id        uuid := gen_random_uuid();
    v_seq               bigint;
    v_effective_at      timestamptz := COALESCE(p_effective_at, now());
    v_metadata          jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_line              record;
    v_new_balance       bigint;
    v_new_entry_seq     bigint;
    v_payload           text;
    v_hash              bytea;
    v_previous_flag     text := COALESCE(current_setting('ledger.internal_write', true), '');
BEGIN
    -- 1. Validation des paramètres scalaires -------------------------------
    IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9:_.\-]{8,200}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : clé d''idempotence invalide';
    END IF;
    IF p_journal_type IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : type de journal obligatoire';
    END IF;
    IF p_description IS NULL OR char_length(p_description) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : libellé obligatoire (1 à 500 caractères)';
    END IF;
    IF p_actor IS NULL OR char_length(p_actor) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : acteur obligatoire';
    END IF;
    IF jsonb_typeof(v_metadata) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : metadata doit être un objet JSON';
    END IF;
    IF (p_reference_type IS NULL) <> (p_reference_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : reference_type et reference_id vont de pair';
    END IF;
    IF v_effective_at > now() + interval '1 minute' OR v_effective_at < now() - interval '31 days' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'ledger : date de valeur hors de la fenêtre autorisée (31 jours dans le passé, pas de futur)';
    END IF;
    IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : entries doit être un tableau JSON';
    END IF;
    v_entry_count := jsonb_array_length(p_entries);
    IF v_entry_count < 2 OR v_entry_count > 100 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger : un journal comporte de 2 à 100 écritures (%s reçues)', v_entry_count);
    END IF;

    -- 2. Validation et normalisation des écritures ---------------------------
    -- Chaque élément : {"account_id": uuid, "direction": "debit"|"credit",
    --                   "amount": entier > 0 (unités mineures), "currency": "EUR"}
    SELECT e.ordinality AS line_no, e.value AS raw
      INTO v_bad
      FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ordinality)
     WHERE CASE
               WHEN jsonb_typeof(e.value) <> 'object' THEN true
               WHEN (SELECT count(*) FROM jsonb_object_keys(e.value)) <> 4 THEN true
               WHEN NOT (e.value ?& ARRAY['account_id', 'direction', 'amount', 'currency']) THEN true
               WHEN jsonb_typeof(e.value -> 'account_id') <> 'string'
                 OR jsonb_typeof(e.value -> 'direction') <> 'string'
                 OR jsonb_typeof(e.value -> 'amount') <> 'number'
                 OR jsonb_typeof(e.value -> 'currency') <> 'string' THEN true
               WHEN (e.value ->> 'account_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
               WHEN (e.value ->> 'direction') NOT IN ('debit', 'credit') THEN true
               WHEN (e.value ->> 'amount') !~ '^[1-9][0-9]{0,15}$' THEN true
               WHEN (e.value ->> 'currency') !~ '^[A-Z]{3}$' THEN true
               ELSE false
           END
     ORDER BY e.ordinality
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger : écriture n°%s invalide : %s', v_bad.line_no, v_bad.raw::text),
            HINT = 'Format attendu : {"account_id","direction","amount" entier > 0 en unités mineures,"currency"}';
    END IF;

    SELECT array_agg(
               ROW(
                   e.ordinality::smallint,
                   (e.value ->> 'account_id')::uuid,
                   (e.value ->> 'direction')::ledger.entry_direction,
                   (e.value ->> 'amount')::bigint,
                   (e.value ->> 'currency')::char(3)
               )::ledger.pending_entry
               ORDER BY e.ordinality)
      INTO v_lines
      FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ordinality);

    SELECT p.line_no, p.amount INTO v_bad
      FROM unnest(v_lines) p
     WHERE p.amount > 1000000000000000
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger : écriture n°%s, montant %s au-delà du plafond par ligne', v_bad.line_no, v_bad.amount);
    END IF;

    -- Un même compte ne peut pas être à la fois débité et crédité dans un
    -- journal : chaque solde évolue de manière monotone, ce qui garantit
    -- qu'aucun solde intermédiaire n'est plus bas que le solde final.
    SELECT p.account_id INTO v_bad
      FROM unnest(v_lines) p
     GROUP BY p.account_id
    HAVING count(DISTINCT p.direction) > 1
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = format('ledger : le compte %s est à la fois débité et crédité', v_bad.account_id);
    END IF;

    -- Équilibre par devise (vérifié ici pour un message clair, revérifié au
    -- COMMIT par le trigger de contrainte).
    SELECT p.currency,
           COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'debit'), 0)  AS debits,
           COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'credit'), 0) AS credits
      INTO v_bad
      FROM unnest(v_lines) p
     GROUP BY p.currency
    HAVING COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'debit'), 0)
        <> COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'credit'), 0)
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG002',
            MESSAGE = format('ledger : journal déséquilibré en %s (débits %s, crédits %s)',
                             v_bad.currency, v_bad.debits, v_bad.credits);
    END IF;

    -- 3. Empreinte de la requête (idempotence) -------------------------------
    SELECT ledger.lp(p_journal_type::text)
        || ledger.lp(p_reference_type)
        || ledger.lp(p_reference_id::text)
        || ledger.lp(p_reverses_journal_id::text)
        || ledger.lp(string_agg(
               ledger.lp(p.line_no::text) || ledger.lp(p.account_id::text)
            || ledger.lp(p.direction::text) || ledger.lp(p.amount::text)
            || ledger.lp(p.currency::text), '' ORDER BY p.line_no))
      INTO v_request_text
      FROM unnest(v_lines) p;
    v_request_sha256 := sha256(convert_to(v_request_text, 'UTF8'));

    SELECT j.id, j.request_sha256 INTO v_existing
      FROM ledger.journals j
     WHERE j.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.request_sha256 <> v_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE = 'LG005',
                MESSAGE = format('ledger : clé d''idempotence %s déjà utilisée avec un contenu différent', p_idempotency_key);
        END IF;
        RETURN v_existing.id;
    END IF;

    -- 4. Verrouillage ordonné des soldes -------------------------------------
    SELECT array_agg(DISTINCT p.account_id ORDER BY p.account_id)
      INTO v_account_ids
      FROM unnest(v_lines) p;

    PERFORM 1
       FROM ledger.account_balances b
      WHERE b.account_id = ANY (v_account_ids)
      ORDER BY b.account_id
        FOR UPDATE;
    GET DIAGNOSTICS v_locked_count = ROW_COUNT;
    IF v_locked_count <> cardinality(v_account_ids) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'ledger : compte inconnu dans le journal';
    END IF;

    -- 5. Contrôles par compte (après verrouillage : état à jour) -------------
    SELECT p.line_no, a.code, a.currency AS account_currency, p.currency
      INTO v_bad
      FROM unnest(v_lines) p
      JOIN ledger.accounts a ON a.id = p.account_id
     WHERE a.currency <> p.currency
     ORDER BY p.line_no
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG004',
            MESSAGE = format('ledger : écriture n°%s en %s sur le compte %s tenu en %s',
                             v_bad.line_no, v_bad.currency, v_bad.code, v_bad.account_currency);
    END IF;

    SELECT a.code, a.status INTO v_bad
      FROM unnest(v_lines) p
      JOIN ledger.accounts a ON a.id = p.account_id
     WHERE a.status = 'closed'
        OR (a.status = 'frozen' AND p_journal_type NOT IN ('reversal', 'adjustment'))
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG003',
            MESSAGE = format('ledger : le compte %s est %s', v_bad.code, v_bad.status);
    END IF;

    -- Provision : solde final de chaque compte non autorisé à découvert.
    SELECT a.code, b.balance AS available, n.delta
      INTO v_bad
      FROM (
            SELECT p.account_id,
                   sum(CASE WHEN p.direction::text = a2.normal_side::text THEN p.amount ELSE -p.amount END) AS delta
              FROM unnest(v_lines) p
              JOIN ledger.accounts a2 ON a2.id = p.account_id
             GROUP BY p.account_id
           ) n
      JOIN ledger.account_balances b ON b.account_id = n.account_id
      JOIN ledger.accounts a ON a.id = n.account_id
     WHERE NOT b.allow_negative
       AND b.balance + n.delta < 0
     ORDER BY a.id
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG001',
            MESSAGE = format('ledger : provision insuffisante sur %s (disponible %s, mouvement %s)',
                             v_bad.code, v_bad.available, v_bad.delta);
    END IF;

    -- 6. Tête de chaîne : sérialisation globale -------------------------------
    SELECT h.last_seq, h.last_hash INTO v_head
      FROM ledger.chain_head h
     WHERE h.singleton
       FOR UPDATE;

    -- Seconde vérification d'idempotence : une transaction concurrente portant
    -- la même clé a pu valider pendant l'attente du verrou.
    SELECT j.id, j.request_sha256 INTO v_existing
      FROM ledger.journals j
     WHERE j.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.request_sha256 <> v_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE = 'LG005',
                MESSAGE = format('ledger : clé d''idempotence %s déjà utilisée avec un contenu différent', p_idempotency_key);
        END IF;
        RETURN v_existing.id;
    END IF;

    v_seq := v_head.last_seq + 1;

    PERFORM set_config('ledger.internal_write', 'on', true);

    -- 7. Application des écritures, dans l'ordre des lignes ------------------
    FOR v_line IN
        SELECT p.line_no, p.account_id, p.direction, p.amount, p.currency, a.normal_side
          FROM unnest(v_lines) p
          JOIN ledger.accounts a ON a.id = p.account_id
         ORDER BY p.line_no
    LOOP
        UPDATE ledger.account_balances b
           SET balance         = b.balance + CASE WHEN v_line.direction::text = v_line.normal_side::text
                                                  THEN v_line.amount ELSE -v_line.amount END,
               last_entry_seq  = b.last_entry_seq + 1,
               last_journal_id = v_journal_id,
               updated_at      = now()
         WHERE b.account_id = v_line.account_id
        RETURNING b.balance, b.last_entry_seq INTO v_new_balance, v_new_entry_seq;

        INSERT INTO ledger.entries (journal_id, line_no, account_id, direction, amount, currency,
                                    balance_after, account_entry_seq)
        VALUES (v_journal_id, v_line.line_no, v_line.account_id, v_line.direction, v_line.amount,
                v_line.currency, v_new_balance, v_new_entry_seq);
    END LOOP;

    -- 8. Empreinte chaînée et en-tête ----------------------------------------
    v_payload := ledger.canonical_payload(
        v_journal_id, v_seq, p_journal_type, p_idempotency_key, p_reference_type, p_reference_id,
        p_reverses_journal_id, p_description, v_metadata, p_actor, v_effective_at
    );
    v_hash := ledger.chain_hash(v_head.last_hash, v_payload);

    INSERT INTO ledger.journals (id, seq, journal_type, idempotency_key, request_sha256, reference_type,
                                 reference_id, reverses_journal_id, description, metadata, actor,
                                 effective_at, prev_hash, hash)
    VALUES (v_journal_id, v_seq, p_journal_type, p_idempotency_key, v_request_sha256, p_reference_type,
            p_reference_id, p_reverses_journal_id, p_description, v_metadata, p_actor,
            v_effective_at, v_head.last_hash, v_hash);

    UPDATE ledger.chain_head
       SET last_seq = v_seq, last_hash = v_hash, updated_at = now()
     WHERE singleton;

    PERFORM set_config('ledger.internal_write', v_previous_flag, true);

    RETURN v_journal_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- API publique : passation d'un journal (tout type sauf contre-passation).
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger.post_journal(
    p_idempotency_key   text,
    p_journal_type      ledger.journal_type,
    p_entries           jsonb,
    p_description       text,
    p_actor             text,
    p_reference_type    text DEFAULT NULL,
    p_reference_id      uuid DEFAULT NULL,
    p_metadata          jsonb DEFAULT '{}'::jsonb,
    p_effective_at      timestamptz DEFAULT NULL
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_journal_type = 'reversal' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG008',
            MESSAGE = 'ledger : une contre-passation passe obligatoirement par ledger.reverse_journal()';
    END IF;
    RETURN ledger._post_journal(
        p_idempotency_key, p_journal_type, p_entries, p_description, p_actor,
        p_reference_type, p_reference_id, p_metadata, p_effective_at, NULL
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- Contre-passation : seul moyen d'annuler un journal. Génère le miroir exact
-- (débits ↔ crédits) et lie les deux journaux. Un journal ne peut être
-- contre-passé qu'une fois et une contre-passation n'est pas contre-passable.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger.reverse_journal(
    p_journal_id        uuid,
    p_idempotency_key   text,
    p_reason            text,
    p_actor             text
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_original  record;
    v_existing  uuid;
    v_entries   jsonb;
BEGIN
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG008',
            MESSAGE = 'ledger.reverse_journal : un motif explicite (≥ 5 caractères) est obligatoire';
    END IF;

    SELECT j.id, j.journal_type, j.reference_type, j.reference_id, j.seq
      INTO v_original
      FROM ledger.journals j
     WHERE j.id = p_journal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG008', MESSAGE = 'ledger.reverse_journal : journal inconnu';
    END IF;
    IF v_original.journal_type = 'reversal' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG008',
            MESSAGE = 'ledger.reverse_journal : une contre-passation ne peut pas être contre-passée';
    END IF;

    SELECT j.id INTO v_existing FROM ledger.journals j WHERE j.reverses_journal_id = p_journal_id;
    IF FOUND THEN
        IF EXISTS (SELECT 1 FROM ledger.journals j WHERE j.id = v_existing AND j.idempotency_key = p_idempotency_key) THEN
            RETURN v_existing;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'LG008',
            MESSAGE = format('ledger.reverse_journal : le journal %s est déjà contre-passé par %s', p_journal_id, v_existing);
    END IF;

    SELECT jsonb_agg(
               jsonb_build_object(
                   'account_id', e.account_id,
                   'direction', CASE e.direction WHEN 'debit' THEN 'credit' ELSE 'debit' END,
                   'amount', e.amount,
                   'currency', e.currency
               ) ORDER BY e.line_no)
      INTO v_entries
      FROM ledger.entries e
     WHERE e.journal_id = p_journal_id;

    RETURN ledger._post_journal(
        p_idempotency_key,
        'reversal',
        v_entries,
        format('Contre-passation du journal n°%s : %s', v_original.seq, p_reason),
        p_actor,
        v_original.reference_type,
        v_original.reference_id,
        jsonb_build_object('reason', p_reason, 'reversed_seq', v_original.seq),
        NULL,
        p_journal_id
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- Vérifications d'intégrité (exécutées par le job de rapprochement et par les
-- auditeurs). Un résultat vide signifie : aucune anomalie.
-- -----------------------------------------------------------------------------

-- Recalcule la chaîne d'empreintes sur un intervalle de seq.
CREATE FUNCTION ledger.verify_chain(p_from_seq bigint DEFAULT 1, p_to_seq bigint DEFAULT NULL)
    RETURNS TABLE (seq bigint, journal_id uuid, problem text)
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_journal       record;
    v_expected_prev bytea;
    v_expected_seq  bigint := GREATEST(p_from_seq, 1);
    v_recomputed    bytea;
    v_head          record;
BEGIN
    IF v_expected_seq = 1 THEN
        v_expected_prev := decode(repeat('00', 32), 'hex');
    ELSE
        SELECT j.hash INTO v_expected_prev FROM ledger.journals j WHERE j.seq = v_expected_seq - 1;
        IF NOT FOUND THEN
            seq := v_expected_seq - 1; journal_id := NULL; problem := 'journal précédent introuvable';
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    FOR v_journal IN
        SELECT j.*
          FROM ledger.journals j
         WHERE j.seq >= v_expected_seq
           AND (p_to_seq IS NULL OR j.seq <= p_to_seq)
         ORDER BY j.seq
    LOOP
        IF v_journal.seq <> v_expected_seq THEN
            seq := v_expected_seq; journal_id := NULL;
            problem := format('trou dans la séquence : %s attendu, %s trouvé', v_expected_seq, v_journal.seq);
            RETURN NEXT;
        END IF;
        IF v_journal.prev_hash <> v_expected_prev THEN
            seq := v_journal.seq; journal_id := v_journal.id; problem := 'prev_hash ne correspond pas au journal précédent';
            RETURN NEXT;
        END IF;
        v_recomputed := ledger.chain_hash(
            v_journal.prev_hash,
            ledger.canonical_payload(
                v_journal.id, v_journal.seq, v_journal.journal_type, v_journal.idempotency_key,
                v_journal.reference_type, v_journal.reference_id, v_journal.reverses_journal_id,
                v_journal.description, v_journal.metadata, v_journal.actor, v_journal.effective_at
            )
        );
        IF v_recomputed <> v_journal.hash THEN
            seq := v_journal.seq; journal_id := v_journal.id; problem := 'empreinte recalculée différente : contenu altéré';
            RETURN NEXT;
        END IF;
        v_expected_prev := v_journal.hash;
        v_expected_seq := v_journal.seq + 1;
    END LOOP;

    IF p_to_seq IS NULL THEN
        SELECT h.last_seq, h.last_hash INTO v_head FROM ledger.chain_head h WHERE h.singleton;
        IF v_head.last_seq <> v_expected_seq - 1 OR (v_head.last_seq > 0 AND v_head.last_hash <> v_expected_prev) THEN
            seq := v_head.last_seq; journal_id := NULL; problem := 'tête de chaîne incohérente avec le dernier journal';
            RETURN NEXT;
        END IF;
    END IF;
END;
$$;

-- Recalcule chaque solde à partir des écritures.
CREATE FUNCTION ledger.verify_balances()
    RETURNS TABLE (
        account_id          uuid,
        account_code        text,
        cached_balance      bigint,
        recomputed_balance  bigint,
        cached_entry_seq    bigint,
        entry_count         bigint,
        last_balance_after  bigint,
        problem             text
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
    WITH recomputed AS (
        SELECT a.id,
               a.code,
               COALESCE(sum(CASE WHEN e.direction::text = a.normal_side::text THEN e.amount ELSE -e.amount END), 0)::bigint AS balance,
               count(e.id) AS entry_count,
               max(e.account_entry_seq) AS max_seq
          FROM ledger.accounts a
          LEFT JOIN ledger.entries e ON e.account_id = a.id
         GROUP BY a.id, a.code
    )
    SELECT r.id,
           r.code,
           b.balance,
           r.balance,
           b.last_entry_seq,
           r.entry_count,
           last_e.balance_after,
           concat_ws(' ; ',
               CASE WHEN b.account_id IS NULL THEN 'ligne de solde absente' END,
               CASE WHEN b.balance <> r.balance THEN 'solde en cache ≠ somme des écritures' END,
               CASE WHEN b.last_entry_seq <> r.entry_count THEN 'nombre d''écritures incohérent' END,
               CASE WHEN r.entry_count > 0 AND r.max_seq <> r.entry_count THEN 'trou dans la numérotation du compte' END,
               CASE WHEN r.entry_count > 0 AND last_e.balance_after <> r.balance THEN 'balance_after final ≠ solde recalculé' END
           )
      FROM recomputed r
      LEFT JOIN ledger.account_balances b ON b.account_id = r.id
      LEFT JOIN LATERAL (
            SELECT e.balance_after
              FROM ledger.entries e
             WHERE e.account_id = r.id
             ORDER BY e.account_entry_seq DESC
             LIMIT 1
      ) last_e ON true
     WHERE b.account_id IS NULL
        OR b.balance <> r.balance
        OR b.last_entry_seq <> r.entry_count
        OR (r.entry_count > 0 AND r.max_seq <> r.entry_count)
        OR (r.entry_count > 0 AND last_e.balance_after <> r.balance);
$$;

-- -----------------------------------------------------------------------------
-- Balance générale par devise : le total des débits égale le total des
-- crédits, et la somme des soldes débiteurs égale la somme des soldes
-- créditeurs. is_balanced = false signale une anomalie grave.
-- -----------------------------------------------------------------------------
CREATE VIEW ledger.trial_balance AS
WITH movements AS (
    SELECT e.currency,
           COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)  AS total_debits,
           COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS total_credits
      FROM ledger.entries e
     GROUP BY e.currency
),
balances AS (
    SELECT b.currency,
           COALESCE(sum(b.balance) FILTER (WHERE a.normal_side = 'debit'), 0)  AS debit_normal_balances,
           COALESCE(sum(b.balance) FILTER (WHERE a.normal_side = 'credit'), 0) AS credit_normal_balances
      FROM ledger.account_balances b
      JOIN ledger.accounts a ON a.id = b.account_id
     GROUP BY b.currency
)
SELECT m.currency,
       m.total_debits,
       m.total_credits,
       b.debit_normal_balances,
       b.credit_normal_balances,
       (m.total_debits = m.total_credits
        AND b.debit_normal_balances = b.credit_normal_balances) AS is_balanced
  FROM movements m
  JOIN balances b ON b.currency = m.currency;

-- Soldes client (portefeuille disponible et fonds réservés) par devise.
CREATE VIEW ledger.customer_balances AS
SELECT a.owner_user_id AS user_id,
       a.currency,
       COALESCE(sum(b.balance) FILTER (WHERE a.account_type = 'customer_wallet'), 0) AS available,
       COALESCE(sum(b.balance) FILTER (WHERE a.account_type = 'customer_hold'), 0)   AS held
  FROM ledger.accounts a
  JOIN ledger.account_balances b ON b.account_id = a.id
 WHERE a.owner_user_id IS NOT NULL
 GROUP BY a.owner_user_id, a.currency;
