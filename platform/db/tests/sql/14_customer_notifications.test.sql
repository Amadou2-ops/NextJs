-- =============================================================================
-- Notifications des clients (0027) : seuls les événements notifiables sont
-- acceptés, pour leur propre client ; une notification par événement ; un
-- envoi confirmé est définitif ; rien n'est supprimé.
-- =============================================================================

DO $$
DECLARE
    v_alice_kyc uuid := (SELECT id FROM kyc.verifications WHERE provider_reference = 'fixture-run-alice');
BEGIN
    INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key) VALUES
        ('kyc_verification', v_alice_kyc, 'kyc.verification_approved', '{}', 'test14:approved'),
        ('kyc_verification', v_alice_kyc, 'kyc.review_required', '{}', 'test14:review'),
        ('transfer', gen_random_uuid(), 'transfers.completed', '{}', 'test14:foreign-transfer'),
        ('transfer', gen_random_uuid(), 'transfers.held_for_review', '{}', 'test14:held');
    PERFORM set_config('test.alice', pg_temp.id('alice')::text, true);
    PERFORM set_config('test.bob', pg_temp.id('bob')::text, true);
END;
$$;

CREATE FUNCTION pg_temp.outbox(p_dedup text)
    RETURNS bigint
    LANGUAGE sql
AS $$
    SELECT id FROM integrations.outbox WHERE dedup_key = p_dedup;
$$;

SET LOCAL ROLE app_api;

DO $$
DECLARE
    v_alice uuid := current_setting('test.alice')::uuid;
    v_bob   uuid := current_setting('test.bob')::uuid;
    v_claim integer;
BEGIN
    -- Interdiction de divulgation : aucune mise en revue n'est notifiable.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'kyc_approved')$q$, pg_temp.outbox('test14:review'), v_alice),
        'LG007', 'mise en revue KYC non notifiable');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'transfer_completed')$q$, pg_temp.outbox('test14:held'), v_alice),
        'LG007', 'retenue de conformité non notifiable');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'kyc_rejected')$q$, pg_temp.outbox('test14:approved'), v_alice),
        'LG007', 'modèle sans rapport avec l''événement');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'kyc_approved')$q$, pg_temp.outbox('test14:approved'), v_bob),
        'LG007', 'vérification d''un autre client');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'transfer_completed')$q$, pg_temp.outbox('test14:foreign-transfer'), v_alice),
        'LG007', 'transfert d''un autre client');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'email', 'kyc_approved')$q$, pg_temp.outbox('test14:approved'), v_alice),
        '23514', 'canal inconnu');

    INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
    VALUES (pg_temp.outbox('test14:approved'), v_alice, 'sms', 'kyc_approved');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'kyc_approved')$q$, pg_temp.outbox('test14:approved'), v_alice),
        '23505', 'une seule notification par événement');

    -- Envoi confirmé : identifiant du prestataire et date exigés ensemble.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE integrations.customer_notifications SET status = 'sent' WHERE outbox_id = %s$q$, pg_temp.outbox('test14:approved')),
        '23514', 'envoi confirmé sans identifiant du prestataire');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE integrations.customer_notifications SET template = 'kyc_rejected' WHERE outbox_id = %s$q$, pg_temp.outbox('test14:approved')),
        '42501', 'modèle non modifiable par le rôle applicatif');
    UPDATE integrations.customer_notifications
       SET status = 'sent', provider_message_id = 'SM0123456789', sent_at = now()
     WHERE outbox_id = pg_temp.outbox('test14:approved');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE integrations.customer_notifications SET status = 'failed', last_error = 'x' WHERE outbox_id = %s$q$, pg_temp.outbox('test14:approved')),
        'LG006', 'un envoi confirmé est définitif');
    PERFORM pg_temp.assert_error(format(
        $q$DELETE FROM integrations.customer_notifications WHERE outbox_id = %s$q$, pg_temp.outbox('test14:approved')),
        '42501', 'aucune suppression par le rôle applicatif');

    -- Le worker réserve les événements de l'outbox.
    SELECT count(*) INTO v_claim FROM integrations.claim_outbox_batch('test14-worker', 500, interval '1 minute');
    PERFORM pg_temp.assert_true(v_claim >= 4, 'réservation d''un lot par le rôle applicatif');
END;
$$;

RESET ROLE;

DO $$
BEGIN
    PERFORM pg_temp.assert_error(
        $q$DELETE FROM integrations.customer_notifications$q$, 'LG006', 'aucune suppression, même par le propriétaire');
    PERFORM pg_temp.assert_error(
        $q$UPDATE integrations.customer_notifications SET template = 'kyc_rejected'$q$, 'LG006', 'identité de la notification figée');
END;
$$;

-- Avis de réinitialisation du mot de passe (0028) : au seul titulaire du compte.
DO $$
DECLARE
    v_alice uuid := pg_temp.id('alice');
BEGIN
    INSERT INTO integrations.outbox (aggregate_type, aggregate_id, event_type, payload, dedup_key) VALUES
        ('user', v_alice, 'customers.password_reset', '{}', 'test14:password-reset'),
        ('user', v_alice, 'customers.suspended', '{}', 'test14:suspended');
    PERFORM set_config('test.alice', v_alice::text, true);
END;
$$;

SET LOCAL ROLE app_api;

DO $$
DECLARE
    v_alice uuid := current_setting('test.alice')::uuid;
    v_bob   uuid := current_setting('test.bob')::uuid;
BEGIN
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'password_changed')$q$, pg_temp.outbox('test14:password-reset'), v_bob),
        'LG007', 'avis destiné à un autre client');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
           VALUES (%s, %L, 'sms', 'password_changed')$q$, pg_temp.outbox('test14:suspended'), v_alice),
        'LG007', 'suspension non notifiable par ce modèle');
    INSERT INTO integrations.customer_notifications (outbox_id, user_id, channel, template)
    VALUES (pg_temp.outbox('test14:password-reset'), v_alice, 'sms', 'password_changed');
END;
$$;

RESET ROLE;
