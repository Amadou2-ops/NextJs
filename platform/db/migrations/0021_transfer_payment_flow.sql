-- =============================================================================
-- 0021 — Cycle de vie financier des transferts
--
-- La base impose désormais que chaque étape d'un transfert soit adossée à son
-- écriture comptable ou à sa tentative de paiement :
--   * funded            ⇐ journal de réservation « transfer:<id>:funding » ;
--   * payout_processing ⇐ tentative de paiement sortant en cours, déjà
--                         comptabilisée (journal lié) ;
--   * completed         ⇐ tentative de paiement sortant réussie ;
--   * payout_failed     ⇐ plus aucune tentative sortante en cours ;
--   * refunded          ⇐ journal de remboursement « transfer:<id>:refund ».
-- Les tentatives de paiement reprennent exactement les montants du transfert
-- et ne peuvent naître qu'au bon statut. Les plafonds KYC (par opération,
-- 24 h, 30 jours, 365 jours glissants, en équivalent USD) sont vérifiés à la
-- création du transfert, sous verrou du client (pas de contournement par
-- requêtes concurrentes).
-- =============================================================================

-- Stripe sert à l'encaissement (cartes, Apple Pay, Google Pay). Un paiement
-- sortant Stripe Connect exigerait un compte connecté vérifié par
-- bénéficiaire, ce qui ne correspond pas au transfert d'argent vers des
-- particuliers : les paiements sortants passent par Flutterwave et Thunes.
-- Changement de capacité : réservé aux migrations, le trigger de gel est
-- suspendu le temps de cette seule instruction (même transaction).
ALTER TABLE payments.providers DISABLE TRIGGER providers_freeze_identity;
UPDATE payments.providers SET supports_payout = false WHERE code = 'stripe';
ALTER TABLE payments.providers ENABLE TRIGGER providers_freeze_identity;

-- Paramètre de route propre au prestataire : identifiant du payeur Thunes,
-- code d'opérateur mobile money Flutterwave (ex. FMM, MPS).
ALTER TABLE payments.payout_corridors ADD COLUMN provider_route_code text;
ALTER TABLE payments.payout_corridors
    ADD CONSTRAINT payout_corridors_route_code_format CHECK (provider_route_code IS NULL OR provider_route_code ~ '^[A-Za-z0-9_-]{1,40}$'),
    ADD CONSTRAINT payout_corridors_thunes_payer CHECK (provider <> 'thunes' OR provider_route_code IS NOT NULL);

-- Un corridor ne peut pas être activé vers un prestataire sans paiement sortant
-- (déjà vérifié par payout_corridors_guard) ; on désactive ceux qui l'étaient.
UPDATE payments.payout_corridors SET is_enabled = false WHERE provider = 'stripe' AND is_enabled;

-- -----------------------------------------------------------------------------
-- Plafonds KYC.
-- -----------------------------------------------------------------------------
CREATE FUNCTION transfers.assert_within_kyc_limits(p_user_id uuid, p_usd_equivalent bigint)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_tier      kyc.kyc_tier;
    v_limits    record;
    v_day       bigint;
    v_month     bigint;
    v_year      bigint;
BEGIN
    -- Verrou du client : deux créations simultanées sont sérialisées.
    SELECT u.kyc_tier INTO v_tier FROM identity.users u WHERE u.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'transfers : client inconnu';
    END IF;
    SELECT l.* INTO v_limits FROM kyc.tier_limits l WHERE l.tier = v_tier;

    SELECT COALESCE(sum(t.usd_equivalent) FILTER (WHERE t.created_at > now() - interval '24 hours'), 0),
           COALESCE(sum(t.usd_equivalent) FILTER (WHERE t.created_at > now() - interval '30 days'), 0),
           COALESCE(sum(t.usd_equivalent), 0)
      INTO v_day, v_month, v_year
      FROM transfers.transfers t
     WHERE t.user_id = p_user_id
       AND t.created_at > now() - interval '365 days'
       AND t.status NOT IN ('cancelled', 'refunded');

    IF p_usd_equivalent > v_limits.single_transfer_max THEN
        RAISE EXCEPTION USING ERRCODE = 'KY001',
            MESSAGE = format('transfers : plafond par opération du niveau %s dépassé', v_tier);
    END IF;
    IF v_day + p_usd_equivalent > v_limits.daily_max THEN
        RAISE EXCEPTION USING ERRCODE = 'KY001', MESSAGE = format('transfers : plafond 24 h du niveau %s dépassé', v_tier);
    END IF;
    IF v_month + p_usd_equivalent > v_limits.monthly_max THEN
        RAISE EXCEPTION USING ERRCODE = 'KY001', MESSAGE = format('transfers : plafond 30 jours du niveau %s dépassé', v_tier);
    END IF;
    IF v_year + p_usd_equivalent > v_limits.annual_max THEN
        RAISE EXCEPTION USING ERRCODE = 'KY001', MESSAGE = format('transfers : plafond 365 jours du niveau %s dépassé', v_tier);
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Contrôle des transferts, version 3 : 0019 + plafonds KYC + adossement
-- comptable des transitions.
-- -----------------------------------------------------------------------------
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

        PERFORM transfers.assert_within_kyc_limits(NEW.user_id, NEW.usd_equivalent);

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

        -- Adossement comptable des transitions.
        CASE NEW.status
            WHEN 'funded' THEN
                IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.idempotency_key = 'transfer:' || NEW.id || ':funding') THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être financé sans écriture de réservation', OLD.reference);
                END IF;
            WHEN 'payout_processing' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout'
                       AND a.status IN ('pending', 'requires_action', 'processing') AND a.ledger_journal_id IS NOT NULL
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s sans paiement sortant comptabilisé en cours', OLD.reference);
                END IF;
            WHEN 'completed' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout' AND a.status = 'succeeded'
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être terminé sans paiement sortant réussi', OLD.reference);
                END IF;
            WHEN 'payout_failed' THEN
                IF EXISTS (
                    SELECT 1 FROM payments.attempts a
                     WHERE a.transfer_id = NEW.id AND a.direction = 'payout'
                       AND a.status IN ('pending', 'requires_action', 'processing', 'succeeded')
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s a un paiement sortant en cours ou réussi', OLD.reference);
                END IF;
            WHEN 'refunded' THEN
                IF NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.idempotency_key = 'transfer:' || NEW.id || ':refund') THEN
                    RAISE EXCEPTION USING ERRCODE = 'TR001',
                        MESSAGE = format('transfers : %s ne peut être remboursé sans écriture de remboursement', OLD.reference);
                END IF;
            ELSE
                NULL;
        END CASE;

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

-- -----------------------------------------------------------------------------
-- Tentatives : naissance au bon statut, montants identiques au transfert.
-- -----------------------------------------------------------------------------
CREATE FUNCTION payments.attempts_insert_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_transfer  record;
    v_corridor  record;
    v_method    record;
BEGIN
    IF NEW.status <> 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = 'PY001', MESSAGE = 'payments.attempts : une tentative commence au statut pending';
    END IF;
    SELECT t.* INTO v_transfer FROM transfers.transfers t WHERE t.id = NEW.transfer_id FOR UPDATE;

    CASE NEW.direction
        WHEN 'payin' THEN
            IF v_transfer.status NOT IN ('created', 'awaiting_funding') OR v_transfer.funding_method = 'wallet_balance' THEN
                RAISE EXCEPTION USING ERRCODE = 'PY001', MESSAGE = 'payments.attempts : encaissement impossible à ce stade';
            END IF;
            IF (NEW.amount, NEW.currency) IS DISTINCT FROM (v_transfer.total_debit, v_transfer.source_currency) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : montant d''encaissement différent du total à payer';
            END IF;
            SELECT m.* INTO v_method FROM payments.payin_methods m WHERE m.id = NEW.payin_method_id;
            IF (v_method.provider, v_method.funding_method, v_method.currency, v_method.country)
               IS DISTINCT FROM (NEW.provider, v_transfer.funding_method, v_transfer.source_currency, v_transfer.source_country) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : moyen d''encaissement incompatible';
            END IF;
        WHEN 'payout' THEN
            IF v_transfer.status <> 'payout_pending' THEN
                RAISE EXCEPTION USING ERRCODE = 'PY001', MESSAGE = 'payments.attempts : paiement sortant impossible à ce stade';
            END IF;
            IF (NEW.amount, NEW.currency) IS DISTINCT FROM (v_transfer.destination_amount, v_transfer.destination_currency) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : montant sortant différent du montant à recevoir';
            END IF;
            SELECT c.* INTO v_corridor FROM payments.payout_corridors c WHERE c.id = NEW.corridor_id;
            IF (v_corridor.provider, v_corridor.destination_country, v_corridor.destination_currency, v_corridor.payout_method)
               IS DISTINCT FROM (NEW.provider, v_transfer.destination_country, v_transfer.destination_currency, v_transfer.payout_method)
               OR (v_corridor.source_country IS NOT NULL AND v_corridor.source_country <> v_transfer.source_country) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : corridor incompatible avec le transfert';
            END IF;
        WHEN 'refund' THEN
            IF v_transfer.status <> 'refund_pending' THEN
                RAISE EXCEPTION USING ERRCODE = 'PY001', MESSAGE = 'payments.attempts : remboursement impossible à ce stade';
            END IF;
            IF (NEW.amount, NEW.currency) IS DISTINCT FROM (v_transfer.total_debit, v_transfer.source_currency) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : montant remboursé différent du total payé';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM payments.attempts p
                 WHERE p.transfer_id = NEW.transfer_id AND p.direction = 'payin' AND p.status = 'succeeded' AND p.provider = NEW.provider
            ) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'payments.attempts : remboursement sans encaissement réussi chez ce prestataire';
            END IF;
    END CASE;
    RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_insert_guard
    BEFORE INSERT ON payments.attempts
    FOR EACH ROW EXECUTE FUNCTION payments.attempts_insert_guard();

-- Recherche des tentatives par référence prestataire (webhooks).
CREATE INDEX attempts_provider_reference_idx ON payments.attempts (provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

REVOKE EXECUTE ON FUNCTION transfers.assert_within_kyc_limits(uuid, bigint), transfers.transfers_guard(),
                           payments.attempts_insert_guard()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfers.assert_within_kyc_limits(uuid, bigint), transfers.transfers_guard(),
                          payments.attempts_insert_guard()
    TO app_api;
GRANT UPDATE (provider_route_code) ON payments.payout_corridors TO app_api;
