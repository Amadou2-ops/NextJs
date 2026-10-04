-- =============================================================================
-- 0027 — Notifications des clients, consommées depuis l'outbox par le worker.
--
-- Une ligne par événement de l'outbox notifié (unicité sur outbox_id) : un
-- événement repris après une panne n'est jamais notifié deux fois une fois
-- l'envoi confirmé. Ni le texte du message ni le numéro ne sont conservés
-- (données personnelles) : seulement le modèle, l'état et la référence du
-- prestataire d'envoi.
--
-- Interdiction de divulgation (LCB-FT) : aucun événement de conformité
-- (mise en revue, alerte, déclaration de soupçon) n'est notifié au client ;
-- la base le garantit en n'acceptant que des modèles connus et des
-- événements dont le type est autorisé.
-- =============================================================================

CREATE TYPE integrations.notification_status AS ENUM ('sending', 'sent', 'failed');

CREATE TABLE integrations.customer_notifications (
    id                  uuid                                PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id           bigint                              NOT NULL UNIQUE REFERENCES integrations.outbox (id),
    user_id             uuid                                NOT NULL REFERENCES identity.users (id),
    channel             text                                NOT NULL,
    template            text                                NOT NULL,
    status              integrations.notification_status    NOT NULL DEFAULT 'sending',
    provider_message_id text,
    last_error          text,
    created_at          timestamptz                         NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    CONSTRAINT customer_notifications_channel CHECK (channel IN ('sms')),
    CONSTRAINT customer_notifications_template CHECK (template IN (
        'transfer_completed', 'transfer_refunded', 'transfer_cancelled',
        'kyc_approved', 'kyc_rejected', 'kyc_resubmission_required')),
    CONSTRAINT customer_notifications_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL AND provider_message_id IS NOT NULL)),
    CONSTRAINT customer_notifications_error_len CHECK (last_error IS NULL OR char_length(last_error) <= 500),
    CONSTRAINT customer_notifications_provider_id_len CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 100)
);

CREATE INDEX customer_notifications_user_idx ON integrations.customer_notifications (user_id, created_at DESC);

CREATE TRIGGER customer_notifications_freeze_identity
    BEFORE UPDATE ON integrations.customer_notifications
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('status', 'provider_message_id', 'last_error', 'sent_at');
CREATE TRIGGER customer_notifications_forbid_delete
    BEFORE DELETE ON integrations.customer_notifications
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Événement notifiable et cohérent avec le client ; un envoi confirmé est définitif.
CREATE FUNCTION integrations.customer_notifications_guard()
    RETURNS trigger
    LANGUAGE plpgsql
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
               ('kyc.resubmission_required', 'kyc_resubmission_required')) THEN
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
    ELSIF OLD.status = 'sent' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'integrations.customer_notifications : un envoi confirmé est définitif';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER customer_notifications_guard
    BEFORE INSERT OR UPDATE ON integrations.customer_notifications
    FOR EACH ROW EXECUTE FUNCTION integrations.customer_notifications_guard();

ALTER FUNCTION integrations.customer_notifications_guard() SECURITY DEFINER;

REVOKE ALL ON integrations.customer_notifications FROM PUBLIC;
GRANT SELECT, INSERT ON integrations.customer_notifications TO app_api;
GRANT UPDATE (status, provider_message_id, last_error, sent_at) ON integrations.customer_notifications TO app_api;
GRANT SELECT ON integrations.customer_notifications TO app_readonly, app_auditor;

ALTER TABLE integrations.customer_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_api_all ON integrations.customer_notifications FOR ALL TO app_api USING (true) WITH CHECK (true);
CREATE POLICY app_readonly_select ON integrations.customer_notifications FOR SELECT TO app_readonly USING (true);
CREATE POLICY app_auditor_select ON integrations.customer_notifications FOR SELECT TO app_auditor USING (true);

-- Le worker (rôle applicatif) réserve les lots de l'outbox.
GRANT EXECUTE ON FUNCTION integrations.claim_outbox_batch(text, integer, interval) TO app_api;
