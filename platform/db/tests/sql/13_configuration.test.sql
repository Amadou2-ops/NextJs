-- =============================================================================
-- Paramétrage sous double validation (0026) : marges, barèmes, corridors,
-- moyens d'encaissement, prestataires et pays ne sont écrits par le rôle
-- applicatif qu'en exécutant une demande approuvée, à l'identique.
-- Toute la transaction partage le même now() : une date d'effet absente vaut
-- l'instant d'exécution.
-- =============================================================================

-- Demande approuvée (créée par le propriétaire), puis contexte d'exécution de
-- son approbateur.
CREATE FUNCTION pg_temp.approved(p_permission text, p_action text, p_target_type text, p_target_id text,
                                 p_payload jsonb, p_requester uuid, p_decider uuid)
    RETURNS uuid
    LANGUAGE plpgsql
AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload, payload_sha256,
                                              justification, requested_by_admin_id)
    VALUES (p_permission, p_action, p_target_type, p_target_id, p_payload, sha256(convert_to(p_payload::text, 'UTF8')),
            'Paramétrage commercial de test', p_requester)
    RETURNING id INTO v_id;
    UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = p_decider WHERE id = v_id;
    RETURN v_id;
END;
$$;

CREATE FUNCTION pg_temp.execute_as(p_admin uuid, p_request uuid)
    RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', p_admin::text, true);
    PERFORM set_config('app.approval_request_id', COALESCE(p_request::text, ''), true);
END;
$$;

DO $$
DECLARE
    v_a         uuid;
    v_b         uuid;
    v_support   uuid;
    v_old_rule  uuid := gen_random_uuid();
BEGIN
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('tarifs.a@transfertplus.example', 'Tarifs A', 'active', '$argon2id$v=19$test') RETURNING id INTO v_a;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('tarifs.b@transfertplus.example', 'Tarifs B', 'active', '$argon2id$v=19$test') RETURNING id INTO v_b;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('tarifs.support@transfertplus.example', 'Support', 'active', '$argon2id$v=19$test') RETURNING id INTO v_support;
    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id) VALUES
        (v_a, 'super_admin', v_b), (v_b, 'super_admin', v_a), (v_support, 'support', v_a);
    PERFORM set_config('test.a', v_a::text, true);
    PERFORM set_config('test.b', v_b::text, true);
    PERFORM set_config('test.support', v_support::text, true);

    -- Règle existante (propriétaire : migrations, exploitation).
    INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, valid_from)
    VALUES (v_old_rule, 'EUR', 'XOF', 150, 10, now() - interval '1 day');
    PERFORM set_config('test.old_rule', v_old_rule::text, true);
    PERFORM set_config('test.new_rule', gen_random_uuid()::text, true);
    PERFORM set_config('test.schedule', gen_random_uuid()::text, true);
    PERFORM set_config('test.corridor', gen_random_uuid()::text, true);
    PERFORM set_config('test.payin', gen_random_uuid()::text, true);
    -- Le prestataire doit gérer le paiement sortant pour qu'un corridor soit activé.
    UPDATE payments.providers SET is_enabled = true WHERE code = 'flutterwave';
END;
$$;

-- -----------------------------------------------------------------------------
-- Rôle applicatif sans acteur du personnel, ou sans demande approuvée.
-- -----------------------------------------------------------------------------
SET LOCAL ROLE app_api;
DO $$
BEGIN
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO fx.pricing_rules (source_currency, destination_currency, margin_bps) VALUES ('EUR', 'XOF', 10)$q$,
        'BO002', 'app_api hors back-office ne crée pas de marge');
    PERFORM pg_temp.assert_error(
        $q$UPDATE ref.countries SET can_receive = true WHERE alpha2 = 'GH'$q$,
        'BO002', 'app_api hors back-office n''ouvre pas de pays');
    PERFORM pg_temp.assert_error(
        $q$UPDATE payments.providers SET is_enabled = false WHERE code = 'thunes'$q$,
        'BO002', 'app_api hors back-office ne coupe pas un prestataire');

    PERFORM pg_temp.execute_as(current_setting('test.a')::uuid, NULL);
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO transfers.fee_schedules (source_currency, fixed_fee) VALUES ('EUR', 0)$q$,
        'BO001', 'un membre habilité sans demande approuvée ne crée pas de barème');
    PERFORM pg_temp.execute_as(current_setting('test.support')::uuid, NULL);
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO transfers.fee_schedules (source_currency, fixed_fee) VALUES ('EUR', 0)$q$,
        'BO002', 'un membre sans pricing:manage est refusé');
END;
$$;
RESET ROLE;

-- -----------------------------------------------------------------------------
-- Marge : nouvelle règle remplaçant l'ancienne, écrite à l'identique.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_request uuid;
BEGIN
    v_request := pg_temp.approved('pricing:manage', 'create_pricing_rule', 'pricing_rule', current_setting('test.new_rule'),
        jsonb_build_object('sourceCurrency', 'EUR', 'destinationCurrency', 'XOF', 'marginBps', 120, 'priority', 10,
                           'validFrom', NULL, 'validTo', NULL, 'replacesRuleId', current_setting('test.old_rule')),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid);
    PERFORM set_config('test.req_rule', v_request::text, true);
END;
$$;

SET LOCAL ROLE app_api;
DO $$
DECLARE
    v_new text := current_setting('test.new_rule');
    v_a   text := current_setting('test.a');
BEGIN
    -- Le demandeur n'exécute pas sa propre demande.
    PERFORM pg_temp.execute_as(v_a::uuid, current_setting('test.req_rule')::uuid);
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id)
                  VALUES (%L, 'EUR', 'XOF', 120, 10, %L)$q$, v_new, v_a),
        'BO001', 'exécution par le demandeur refusée');

    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_rule')::uuid);
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id)
                  VALUES (%L, 'EUR', 'XOF', 300, 10, %L)$q$, v_new, v_a),
        'BO001', 'marge différente de la demande refusée');
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id)
                  VALUES (%L, 'EUR', 'XOF', 120, 10, %L)$q$, gen_random_uuid(), v_a),
        'BO001', 'autre identifiant que la cible refusé');
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id, valid_from)
                  VALUES (%L, 'EUR', 'XOF', 120, 10, %L, now() + interval '1 day')$q$, v_new, v_a),
        'BO001', 'date d''effet différente refusée');
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id)
                  VALUES (%L, 'EUR', 'XOF', 120, 10, %L)$q$, v_new, current_setting('test.b')),
        'BO001', 'auteur autre que le demandeur refusé');

    EXECUTE format($q$INSERT INTO fx.pricing_rules (id, source_currency, destination_currency, margin_bps, priority, created_by_admin_id)
                      VALUES (%L, 'EUR', 'XOF', 120, 10, %L)$q$, v_new, v_a);

    -- Clôture de l'ancienne règle : uniquement à la date d'effet de la nouvelle.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE fx.pricing_rules SET valid_to = now() + interval '1 hour' WHERE id = %L$q$, current_setting('test.old_rule')),
        'BO001', 'clôture à une autre date refusée');
    EXECUTE format($q$UPDATE fx.pricing_rules SET valid_to = now() WHERE id = %L$q$, current_setting('test.old_rule'));
    -- La demande ne vaut que pour la règle remplacée.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE fx.pricing_rules SET valid_to = now() WHERE id = %L$q$, v_new),
        'BO001', 'clôture d''une autre règle refusée');
    -- Une règle publiée ne change pas de marge.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE fx.pricing_rules SET margin_bps = 1 WHERE id = %L$q$, v_new),
        '42501', 'marge figée (droit de colonne)');
END;
$$;
RESET ROLE;

DO $$
BEGIN
    PERFORM pg_temp.assert_true(
        (SELECT valid_to = now() FROM fx.pricing_rules WHERE id = current_setting('test.old_rule')::uuid),
        'ancienne marge close à l''entrée en vigueur de la nouvelle');
    PERFORM pg_temp.assert_true(
        (SELECT margin_bps = 120 AND created_by_admin_id = current_setting('test.a')::uuid FROM fx.pricing_rules
          WHERE id = current_setting('test.new_rule')::uuid),
        'nouvelle marge écrite à l''identique, au nom du demandeur');
END;
$$;

-- -----------------------------------------------------------------------------
-- Barème : création, date d'effet dépassée refusée, clôture.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_payload jsonb := jsonb_build_object(
        'sourceCountry', 'FR', 'destinationCountry', 'SN', 'sourceCurrency', 'EUR', 'destinationCurrency', 'XOF',
        'payoutMethod', 'mobile_money', 'fundingMethod', NULL, 'fixedFee', '199', 'percentageBps', 50,
        'minFee', '199', 'maxFee', '1500', 'priority', 20, 'validFrom', NULL, 'validTo', NULL, 'replacesScheduleId', NULL);
    v_late uuid := gen_random_uuid();
BEGIN
    PERFORM set_config('test.req_schedule', pg_temp.approved('pricing:manage', 'create_fee_schedule', 'fee_schedule',
        current_setting('test.schedule'), v_payload, current_setting('test.b')::uuid, current_setting('test.a')::uuid)::text, true);
    PERFORM set_config('test.late_schedule', v_late::text, true);
    PERFORM set_config('test.req_late', pg_temp.approved('pricing:manage', 'create_fee_schedule', 'fee_schedule', v_late::text,
        v_payload || jsonb_build_object('validFrom', (now() - interval '1 hour')::text),
        current_setting('test.b')::uuid, current_setting('test.a')::uuid)::text, true);
    PERFORM set_config('test.req_close', pg_temp.approved('pricing:manage', 'close_fee_schedule', 'fee_schedule',
        current_setting('test.schedule'), jsonb_build_object('validTo', (now() + interval '30 days')::text),
        current_setting('test.b')::uuid, current_setting('test.a')::uuid)::text, true);
END;
$$;

SET LOCAL ROLE app_api;
DO $$
DECLARE
    v_insert text := $q$INSERT INTO transfers.fee_schedules (id, source_country, destination_country, source_currency, destination_currency,
                         payout_method, fixed_fee, percentage_bps, min_fee, max_fee, priority, created_by_admin_id, valid_from)
                       VALUES (%L, 'FR', 'SN', 'EUR', 'XOF', 'mobile_money', 199, 50, 199, %s, 20, %L, %s)$q$;
BEGIN
    PERFORM pg_temp.execute_as(current_setting('test.a')::uuid, current_setting('test.req_schedule')::uuid);
    PERFORM pg_temp.assert_error(format(v_insert, current_setting('test.schedule'), 'NULL', current_setting('test.b'), 'now()'),
        'BO001', 'plafond de frais absent de la demande refusé');
    EXECUTE format(v_insert, current_setting('test.schedule'), '1500', current_setting('test.b'), 'now()');

    PERFORM pg_temp.execute_as(current_setting('test.a')::uuid, current_setting('test.req_late')::uuid);
    PERFORM pg_temp.assert_error(
        format(v_insert, current_setting('test.late_schedule'), '1500', current_setting('test.b'), quote_literal((now() - interval '1 hour')::text)),
        'BO001', 'date d''effet dépassée refusée (aucun effet rétroactif)');

    PERFORM pg_temp.execute_as(current_setting('test.a')::uuid, current_setting('test.req_close')::uuid);
    EXECUTE format($q$UPDATE transfers.fee_schedules SET valid_to = now() + interval '30 days' WHERE id = %L$q$, current_setting('test.schedule'));
    -- Une clôture n'est jamais repoussée ni retirée.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE transfers.fee_schedules SET valid_to = NULL WHERE id = %L$q$, current_setting('test.schedule')),
        'BO001', 'clôture retirée refusée');
END;
$$;
RESET ROLE;

-- -----------------------------------------------------------------------------
-- Corridor de paiement sortant : création, modification des seuls paramètres.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_params jsonb := jsonb_build_object('priority', 10, 'minAmount', '1000', 'maxAmount', '2000000', 'costFixed', '0', 'costBps', 120,
                                        'estimatedDeliveryMinutes', 15, 'isEnabled', true, 'providerRouteCode', NULL);
BEGIN
    PERFORM set_config('test.req_corridor', pg_temp.approved('routing:manage', 'create_payout_corridor', 'payout_corridor', current_setting('test.corridor'),
        v_params || jsonb_build_object('sourceCountry', 'FR', 'destinationCountry', 'SN', 'destinationCurrency', 'XOF',
                                       'payoutMethod', 'bank_account', 'provider', 'flutterwave'),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
    PERFORM set_config('test.req_corridor_update', pg_temp.approved('routing:manage', 'update_payout_corridor', 'payout_corridor',
        current_setting('test.corridor'), v_params || jsonb_build_object('isEnabled', false, 'maxAmount', '1000000'),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
END;
$$;

SET LOCAL ROLE app_api;
DO $$
DECLARE
    v_id text := current_setting('test.corridor');
BEGIN
    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_corridor')::uuid);
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO payments.payout_corridors (id, source_country, destination_country, destination_currency, payout_method, provider,
                     priority, min_amount, max_amount, cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled)
                  VALUES (%L, 'FR', 'SN', 'XOF', 'bank_account', 'thunes', 10, 1000, 2000000, 0, 120, 15, true)$q$, v_id),
        'BO001', 'autre prestataire que la demande refusé');
    EXECUTE format($q$INSERT INTO payments.payout_corridors (id, source_country, destination_country, destination_currency, payout_method, provider,
                         priority, min_amount, max_amount, cost_fixed, cost_bps, estimated_delivery_minutes, is_enabled)
                      VALUES (%L, 'FR', 'SN', 'XOF', 'bank_account', 'flutterwave', 10, 1000, 2000000, 0, 120, 15, true)$q$, v_id);

    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_corridor_update')::uuid);
    PERFORM pg_temp.assert_error(
        format($q$UPDATE payments.payout_corridors SET destination_country = 'CI', is_enabled = false, max_amount = 1000000 WHERE id = %L$q$, v_id),
        'BO001', 'pays d''un corridor figé');
    PERFORM pg_temp.assert_error(
        format($q$UPDATE payments.payout_corridors SET is_enabled = false WHERE id = %L$q$, v_id),
        'BO001', 'modification partielle (plafond non appliqué) refusée');
    EXECUTE format($q$UPDATE payments.payout_corridors SET is_enabled = false, max_amount = 1000000 WHERE id = %L$q$, v_id);
END;
$$;
RESET ROLE;

-- -----------------------------------------------------------------------------
-- Moyen d'encaissement, prestataire et pays.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM set_config('test.req_payin', pg_temp.approved('routing:manage', 'create_payin_method', 'payin_method', current_setting('test.payin'),
        jsonb_build_object('country', 'FR', 'currency', 'EUR', 'fundingMethod', 'card', 'provider', 'stripe', 'priority', 10,
                           'minAmount', '500', 'maxAmount', '500000', 'costFixed', '25', 'costBps', 140, 'isEnabled', false),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
    PERFORM set_config('test.req_provider', pg_temp.approved('routing:manage', 'set_payment_provider', 'payment_provider', 'thunes',
        jsonb_build_object('isEnabled', true), current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
    PERFORM set_config('test.req_country', pg_temp.approved('countries:manage', 'update_country', 'country', 'GH',
        jsonb_build_object('canSend', false, 'canReceive', true, 'riskLevel', 'medium'),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
    PERFORM set_config('test.req_prohibited', pg_temp.approved('countries:manage', 'update_country', 'country', 'KP',
        jsonb_build_object('canSend', false, 'canReceive', true, 'riskLevel', 'prohibited'),
        current_setting('test.a')::uuid, current_setting('test.b')::uuid)::text, true);
END;
$$;

SET LOCAL ROLE app_api;
DO $$
BEGIN
    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_payin')::uuid);
    EXECUTE format($q$INSERT INTO payments.payin_methods (id, country, currency, funding_method, provider, priority, min_amount, max_amount,
                         cost_fixed, cost_bps, is_enabled)
                      VALUES (%L, 'FR', 'EUR', 'card', 'stripe', 10, 500, 500000, 25, 140, false)$q$, current_setting('test.payin'));

    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_provider')::uuid);
    PERFORM pg_temp.assert_error(
        $q$UPDATE payments.providers SET is_enabled = true WHERE code = 'stripe'$q$,
        'BO001', 'la demande ne vaut que pour son prestataire');
    EXECUTE $q$UPDATE payments.providers SET is_enabled = true WHERE code = 'thunes'$q$;

    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_country')::uuid);
    PERFORM pg_temp.assert_error(
        $q$UPDATE ref.countries SET can_send = true, can_receive = true, risk_level = 'medium', risk_reviewed_at = now() WHERE alpha2 = 'GH'$q$,
        'BO001', 'ouverture à l''envoi non demandée refusée');
    PERFORM pg_temp.assert_error(
        $q$UPDATE ref.countries SET can_receive = true, risk_level = 'medium' WHERE alpha2 = 'GH'$q$,
        'BO001', 'revue non datée refusée');
    EXECUTE $q$UPDATE ref.countries SET can_send = false, can_receive = true, risk_level = 'medium', risk_reviewed_at = now() WHERE alpha2 = 'GH'$q$;

    -- Même approuvée, l'ouverture d'un pays interdit reste impossible.
    PERFORM pg_temp.execute_as(current_setting('test.b')::uuid, current_setting('test.req_prohibited')::uuid);
    PERFORM pg_temp.assert_error(
        $q$UPDATE ref.countries SET can_send = false, can_receive = true, risk_level = 'prohibited', risk_reviewed_at = now() WHERE alpha2 = 'KP'$q$,
        '23514', 'pays interdit jamais ouvert');
END;
$$;
RESET ROLE;

DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT can_receive AND NOT can_send FROM ref.countries WHERE alpha2 = 'GH'), 'Ghana ouvert à la réception');
    PERFORM pg_temp.assert_true((SELECT is_enabled FROM payments.providers WHERE code = 'thunes'), 'Thunes activé');
    PERFORM pg_temp.assert_true(
        (SELECT NOT is_enabled AND max_amount = 1000000 FROM payments.payout_corridors WHERE id = current_setting('test.corridor')::uuid),
        'corridor modifié à l''identique');
    -- Le propriétaire (migrations, exploitation) n'est pas soumis à la demande.
    PERFORM set_config('app.approval_request_id', '', true);
    UPDATE ref.countries SET can_send = true WHERE alpha2 = 'GH';
    PERFORM pg_temp.assert_true((SELECT can_send FROM ref.countries WHERE alpha2 = 'GH'), 'écriture du propriétaire acceptée');
END;
$$;
