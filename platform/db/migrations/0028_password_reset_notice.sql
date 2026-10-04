-- =============================================================================
-- 0028 — Avis de sécurité après une réinitialisation du mot de passe.
--
-- Le client est prévenu par SMS de toute réinitialisation (événement
-- customers.password_reset, agrégat « user ») : une prise de contrôle par
-- détournement de la carte SIM ne passe pas inaperçue du titulaire.
-- =============================================================================

ALTER TABLE integrations.customer_notifications DROP CONSTRAINT customer_notifications_template;
ALTER TABLE integrations.customer_notifications ADD CONSTRAINT customer_notifications_template CHECK (template IN (
    'transfer_completed', 'transfer_refunded', 'transfer_cancelled',
    'kyc_approved', 'kyc_rejected', 'kyc_resubmission_required',
    'password_changed'));

CREATE OR REPLACE FUNCTION integrations.customer_notifications_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_event integrations.outbox;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT o.* INTO v_event FROM integrations.outbox o WHERE o.id = NEW.outbox_id;
        IF (v_event.event_type, NEW.template) NOT IN (
               ('transfers.completed', 'transfer_completed'),
               ('transfers.refunded', 'transfer_refunded'),
               ('transfers.cancelled', 'transfer_cancelled'),
               ('kyc.verification_approved', 'kyc_approved'),
               ('kyc.verification_rejected', 'kyc_rejected'),
               ('kyc.resubmission_required', 'kyc_resubmission_required'),
               ('customers.password_reset', 'password_changed')) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007',
                MESSAGE = format('integrations.customer_notifications : %s n''est pas notifiable par %s', v_event.event_type, NEW.template);
        END IF;
        IF v_event.aggregate_type = 'transfer'
           AND NOT EXISTS (SELECT 1 FROM transfers.transfers t WHERE t.id = v_event.aggregate_id AND t.user_id = NEW.user_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'integrations.customer_notifications : transfert d''un autre client';
        END IF;
        IF v_event.aggregate_type = 'kyc_verification'
           AND NOT EXISTS (SELECT 1 FROM kyc.verifications v WHERE v.id = v_event.aggregate_id AND v.user_id = NEW.user_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'integrations.customer_notifications : vérification d''un autre client';
        END IF;
        IF v_event.aggregate_type = 'user' AND v_event.aggregate_id <> NEW.user_id THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'integrations.customer_notifications : avis destiné à un autre client';
        END IF;
    ELSIF OLD.status = 'sent' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'integrations.customer_notifications : un envoi confirmé est définitif';
    END IF;
    RETURN NEW;
END;
$$;
