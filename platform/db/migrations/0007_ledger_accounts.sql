-- =============================================================================
-- 0007 — Registre : plan de comptes et soldes
--
-- Chaque compte est mono-devise. Le solde est exprimé dans le sens normal du
-- compte : pour un compte à solde créditeur (passif, produit), solde =
-- crédits − débits ; pour un compte à solde débiteur (actif, charge),
-- solde = débits − crédits. Un portefeuille client positif signifie donc
-- « nous devons cette somme au client ».
--
-- Le solde courant (ledger.account_balances) est un cache dérivé : il n'est
-- écrit QUE par ledger.post_journal() dans la même transaction que les
-- écritures, et ledger.verify_balances() le recalcule intégralement à partir
-- des écritures pour prouver qu'il n'a pas divergé.
-- =============================================================================

CREATE TABLE ledger.accounts (
    id              uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Code stable et lisible, unique :
    --   customer:<user_id>:<type>:<devise>
    --   provider:<prestataire>:<type>:<devise>
    --   system:<type>:<devise>
    code            text                    NOT NULL UNIQUE,
    account_type    ledger.account_type     NOT NULL,
    normal_side     ledger.normal_side      NOT NULL,
    currency        char(3)                 NOT NULL REFERENCES ref.currencies (code),
    owner_user_id   uuid                    REFERENCES identity.users (id),
    provider        payments.provider,
    allow_negative  boolean                 NOT NULL DEFAULT false,
    status          ledger.account_status   NOT NULL DEFAULT 'active',
    status_reason   text,
    name            text                    NOT NULL,
    created_at      timestamptz             NOT NULL DEFAULT now(),
    updated_at      timestamptz             NOT NULL DEFAULT now(),
    frozen_at       timestamptz,
    closed_at       timestamptz,

    -- Le sens normal est imposé par le type : impossible de créer un
    -- portefeuille client « à l'envers » qui inverserait les soldes.
    CONSTRAINT accounts_normal_side_matches_type CHECK (
        normal_side = CASE account_type
            WHEN 'customer_wallet'      THEN 'credit'::ledger.normal_side
            WHEN 'customer_hold'        THEN 'credit'::ledger.normal_side
            WHEN 'payout_clearing'      THEN 'credit'::ledger.normal_side
            WHEN 'fee_revenue'          THEN 'credit'::ledger.normal_side
            WHEN 'fx_revenue'           THEN 'credit'::ledger.normal_side
            WHEN 'equity'               THEN 'credit'::ledger.normal_side
            WHEN 'provider_settlement'  THEN 'debit'::ledger.normal_side
            WHEN 'payin_clearing'       THEN 'debit'::ledger.normal_side
            WHEN 'fx_position'          THEN 'debit'::ledger.normal_side
            WHEN 'chargeback_loss'      THEN 'debit'::ledger.normal_side
            WHEN 'provider_fee_expense' THEN 'debit'::ledger.normal_side
            WHEN 'suspense'             THEN 'debit'::ledger.normal_side
        END
    ),
    -- Les comptes clients appartiennent à un client et ne peuvent JAMAIS être
    -- négatifs ; les comptes internes n'ont pas de propriétaire.
    CONSTRAINT accounts_customer_ownership CHECK (
        (account_type IN ('customer_wallet', 'customer_hold')) = (owner_user_id IS NOT NULL)
    ),
    CONSTRAINT accounts_customer_never_negative CHECK (
        account_type NOT IN ('customer_wallet', 'customer_hold') OR allow_negative = false
    ),
    -- Seuls les comptes techniques de position et d'attente peuvent passer
    -- en négatif (une position de change courte est normale).
    CONSTRAINT accounts_negative_whitelist CHECK (
        allow_negative = false OR account_type IN ('fx_position', 'suspense', 'equity')
    ),
    CONSTRAINT accounts_provider_scope CHECK (
        (account_type IN ('provider_settlement', 'payin_clearing', 'payout_clearing', 'provider_fee_expense'))
            = (provider IS NOT NULL)
    ),
    CONSTRAINT accounts_status_dates CHECK (
        (status <> 'closed' OR closed_at IS NOT NULL)
        AND (status <> 'frozen' OR frozen_at IS NOT NULL)
    ),
    CONSTRAINT accounts_status_reason CHECK (status = 'active' OR status_reason IS NOT NULL),
    CONSTRAINT accounts_code_format CHECK (code ~ '^(customer|provider|system):[a-z0-9_:\-]+:[A-Z]{3}$')
);

-- Un seul compte d'un type donné par client et par devise.
CREATE UNIQUE INDEX accounts_customer_unique_idx
    ON ledger.accounts (owner_user_id, account_type, currency)
    WHERE owner_user_id IS NOT NULL;

-- Un seul compte d'un type donné par prestataire et par devise.
CREATE UNIQUE INDEX accounts_provider_unique_idx
    ON ledger.accounts (provider, account_type, currency)
    WHERE provider IS NOT NULL;

-- Un seul compte système d'un type donné par devise.
CREATE UNIQUE INDEX accounts_system_unique_idx
    ON ledger.accounts (account_type, currency)
    WHERE owner_user_id IS NULL AND provider IS NULL;

CREATE TRIGGER accounts_set_updated_at
    BEFORE UPDATE ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();

-- Type, devise, sens normal, propriétaire et autorisation de découvert sont
-- figés pour toujours : changer l'un d'eux réinterpréterait l'historique.
CREATE TRIGGER accounts_freeze_identity
    BEFORE UPDATE ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'status_reason', 'name', 'updated_at', 'frozen_at', 'closed_at'
    );

CREATE TRIGGER accounts_forbid_delete
    BEFORE DELETE ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER accounts_no_truncate
    BEFORE TRUNCATE ON ledger.accounts
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();

-- -----------------------------------------------------------------------------
-- Solde courant (cache dérivé, verrouillé par SELECT ... FOR UPDATE lors de
-- chaque écriture). allow_negative est recopié pour que la contrainte de
-- non-négativité soit une contrainte CHECK physique de PostgreSQL.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger.account_balances (
    account_id          uuid        PRIMARY KEY REFERENCES ledger.accounts (id),
    currency            char(3)     NOT NULL REFERENCES ref.currencies (code),
    allow_negative      boolean     NOT NULL,
    balance             bigint      NOT NULL DEFAULT 0,
    -- Nombre d'écritures appliquées au compte (= dernier account_entry_seq).
    last_entry_seq      bigint      NOT NULL DEFAULT 0,
    last_journal_id     uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT account_balances_non_negative CHECK (allow_negative OR balance >= 0),
    CONSTRAINT account_balances_seq_non_negative CHECK (last_entry_seq >= 0)
);

-- Création automatique de la ligne de solde à l'ouverture du compte.
CREATE FUNCTION ledger.accounts_create_balance()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_previous_flag text := COALESCE(current_setting('ledger.internal_write', true), '');
BEGIN
    PERFORM set_config('ledger.internal_write', 'on', true);
    INSERT INTO ledger.account_balances (account_id, currency, allow_negative)
    VALUES (NEW.id, NEW.currency, NEW.allow_negative);
    PERFORM set_config('ledger.internal_write', v_previous_flag, true);
    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_create_balance
    AFTER INSERT ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION ledger.accounts_create_balance();

-- Un compte ne peut être clôturé qu'à solde nul ; un compte clôturé ne peut
-- pas être rouvert.
CREATE FUNCTION ledger.accounts_status_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_balance bigint;
BEGIN
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG003',
            MESSAGE = format('ledger.accounts : le compte %s est clôturé définitivement', OLD.code);
    END IF;
    IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
        SELECT b.balance INTO v_balance FROM ledger.account_balances b WHERE b.account_id = NEW.id FOR UPDATE;
        IF v_balance <> 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'LG003',
                MESSAGE = format('ledger.accounts : clôture impossible, solde non nul (%s)', v_balance);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_status_guard
    BEFORE UPDATE OF status ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION ledger.accounts_status_guard();
