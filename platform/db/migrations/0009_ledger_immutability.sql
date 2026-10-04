-- =============================================================================
-- 0009 — Registre : immuabilité et invariants comptables
--
-- Trois lignes de défense, indépendantes les unes des autres :
--   1. Privilèges (0016) : le rôle applicatif n'a AUCUN droit d'écriture sur
--      les tables du registre. Il ne peut qu'appeler ledger.post_journal().
--   2. Garde d'écriture interne : même le propriétaire des tables ne peut
--      insérer dans journals/entries/account_balances/chain_head qu'au travers
--      des fonctions du registre (drapeau transactionnel ledger.internal_write).
--   3. Invariants vérifiés au COMMIT (triggers de contrainte différés) :
--      chaque journal a ≥ 2 écritures, équilibrées par devise, dans la devise
--      de leur compte. Une transaction qui violerait l'équilibre est annulée.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ajout seul : journaux, écritures, ancrages.
-- -----------------------------------------------------------------------------
CREATE TRIGGER journals_immutable
    BEFORE UPDATE OR DELETE ON ledger.journals
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER journals_no_truncate
    BEFORE TRUNCATE ON ledger.journals
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

CREATE TRIGGER entries_immutable
    BEFORE UPDATE OR DELETE ON ledger.entries
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER entries_no_truncate
    BEFORE TRUNCATE ON ledger.entries
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

CREATE TRIGGER chain_anchors_immutable
    BEFORE UPDATE OR DELETE ON ledger.chain_anchors
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER chain_anchors_no_truncate
    BEFORE TRUNCATE ON ledger.chain_anchors
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

CREATE TRIGGER chain_head_forbid_delete
    BEFORE DELETE ON ledger.chain_head
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER chain_head_no_truncate
    BEFORE TRUNCATE ON ledger.chain_head
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

CREATE TRIGGER account_balances_forbid_delete
    BEFORE DELETE ON ledger.account_balances
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER account_balances_no_truncate
    BEFORE TRUNCATE ON ledger.account_balances
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- -----------------------------------------------------------------------------
-- Garde d'écriture interne.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger.require_internal_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('ledger.internal_write', true), '') <> 'on' THEN
        RAISE EXCEPTION USING
            ERRCODE = 'LG006',
            MESSAGE = format('%I.%I : écriture directe interdite (%s)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP),
            HINT = 'Utiliser ledger.post_journal() ou ledger.reverse_journal().';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER journals_internal_write_only
    BEFORE INSERT ON ledger.journals
    FOR EACH ROW EXECUTE FUNCTION ledger.require_internal_write();
CREATE TRIGGER entries_internal_write_only
    BEFORE INSERT ON ledger.entries
    FOR EACH ROW EXECUTE FUNCTION ledger.require_internal_write();
CREATE TRIGGER account_balances_internal_write_only
    BEFORE INSERT OR UPDATE ON ledger.account_balances
    FOR EACH ROW EXECUTE FUNCTION ledger.require_internal_write();
CREATE TRIGGER chain_head_internal_write_only
    BEFORE INSERT OR UPDATE ON ledger.chain_head
    FOR EACH ROW EXECUTE FUNCTION ledger.require_internal_write();

-- Les colonnes d'identité d'une ligne de solde sont figées.
CREATE TRIGGER account_balances_freeze_identity
    BEFORE UPDATE ON ledger.account_balances
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'balance', 'last_entry_seq', 'last_journal_id', 'updated_at'
    );

-- La tête de chaîne n'avance que d'un pas à la fois.
CREATE FUNCTION ledger.chain_head_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.last_seq <> OLD.last_seq + 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG009',
            MESSAGE = format('ledger.chain_head : avance de %s à %s refusée', OLD.last_seq, NEW.last_seq);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chain_head_guard
    BEFORE UPDATE ON ledger.chain_head
    FOR EACH ROW EXECUTE FUNCTION ledger.chain_head_guard();

-- Un ancrage doit correspondre exactement à un journal existant.
CREATE FUNCTION ledger.chain_anchors_validate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.seq = NEW.seq AND j.hash = NEW.hash) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG009',
            MESSAGE = format('ledger.chain_anchors : aucune entrée de seq %s avec cette empreinte', NEW.seq);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chain_anchors_validate
    BEFORE INSERT ON ledger.chain_anchors
    FOR EACH ROW EXECUTE FUNCTION ledger.chain_anchors_validate();

-- -----------------------------------------------------------------------------
-- Invariants vérifiés au COMMIT.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ledger.assert_journal_balanced(p_journal_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_entry_count   integer;
    v_unbalanced    record;
    v_mismatch      record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.id = p_journal_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG002',
            MESSAGE = format('ledger : écritures sans journal (%s)', p_journal_id);
    END IF;

    SELECT count(*) INTO v_entry_count FROM ledger.entries e WHERE e.journal_id = p_journal_id;
    IF v_entry_count < 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG002',
            MESSAGE = format('ledger : le journal %s doit comporter au moins 2 écritures (%s)',
                             p_journal_id, v_entry_count);
    END IF;

    SELECT e.currency,
           sum(e.amount) FILTER (WHERE e.direction = 'debit')  AS debits,
           sum(e.amount) FILTER (WHERE e.direction = 'credit') AS credits
      INTO v_unbalanced
      FROM ledger.entries e
     WHERE e.journal_id = p_journal_id
     GROUP BY e.currency
    HAVING COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)
        <> COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0)
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG002',
            MESSAGE = format('ledger : journal %s déséquilibré en %s (débits %s, crédits %s)',
                             p_journal_id, v_unbalanced.currency,
                             COALESCE(v_unbalanced.debits, 0), COALESCE(v_unbalanced.credits, 0));
    END IF;

    SELECT e.line_no, e.currency, a.currency AS account_currency
      INTO v_mismatch
      FROM ledger.entries e
      JOIN ledger.accounts a ON a.id = e.account_id
     WHERE e.journal_id = p_journal_id
       AND e.currency <> a.currency
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG004',
            MESSAGE = format('ledger : journal %s ligne %s en %s sur un compte en %s',
                             p_journal_id, v_mismatch.line_no, v_mismatch.currency, v_mismatch.account_currency);
    END IF;
END;
$$;

CREATE FUNCTION ledger.entries_check_balanced()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM ledger.assert_journal_balanced(NEW.journal_id);
    RETURN NULL;
END;
$$;

CREATE FUNCTION ledger.journals_check_balanced()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM ledger.assert_journal_balanced(NEW.id);
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_balanced_at_commit
    AFTER INSERT ON ledger.entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.entries_check_balanced();

CREATE CONSTRAINT TRIGGER journals_balanced_at_commit
    AFTER INSERT ON ledger.journals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.journals_check_balanced();
