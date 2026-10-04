-- =============================================================================
-- Back-office opérationnel (0023) : habilitations et double validation
-- vérifiées par la base, invitation et activation du personnel.
-- =============================================================================
DO $$
DECLARE
    v_super_a       uuid;
    v_super_b       uuid;
    v_risk          uuid;
    v_support       uuid;
    v_request       uuid;
    v_invited       uuid;
    v_payload       jsonb;
    v_alert         uuid;
    v_case          uuid;
    v_journal       uuid;
    v_alice         uuid := pg_temp.id('alice');
BEGIN
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('super.a@transfertplus.example', 'Super A', 'active', '$argon2id$v=19$test') RETURNING id INTO v_super_a;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('super.b@transfertplus.example', 'Super B', 'active', '$argon2id$v=19$test') RETURNING id INTO v_super_b;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('risque@transfertplus.example', 'Analyste', 'active', '$argon2id$v=19$test') RETURNING id INTO v_risk;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash) VALUES
        ('support@transfertplus.example', 'Support', 'active', '$argon2id$v=19$test') RETURNING id INTO v_support;
    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id) VALUES
        (v_super_a, 'super_admin', v_super_b),
        (v_super_b, 'super_admin', v_super_a),
        (v_risk, 'risk_manager', v_super_a),
        (v_support, 'support', v_super_a);

    -- -------------------------------------------------------------------------
    -- Invitation : uniquement par l'approbateur d'une demande admins:manage.
    -- -------------------------------------------------------------------------
    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_super_a::text, true);
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.create_invited_admin('nouveau@transfertplus.example', 'Nouvel agent', ARRAY['10.0.0.0/8']::cidr[],
               ARRAY['support'], sha256('jeton-1'), now() + interval '72 hours')$q$,
        'BO001', 'invitation sans demande approuvée refusée');

    v_payload := jsonb_build_object('email', 'nouveau@transfertplus.example', 'roles', jsonb_build_array('support'));
    INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload, payload_sha256,
                                              justification, requested_by_admin_id)
    VALUES ('admins:manage', 'invite_admin', 'admin_invitation', 'nouveau@transfertplus.example', v_payload,
            sha256(convert_to(v_payload::text, 'UTF8')), 'Renfort de l''équipe support', v_super_a)
    RETURNING id INTO v_request;
    UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = v_super_b WHERE id = v_request;
    PERFORM set_config('app.approval_request_id', v_request::text, true);

    -- Le demandeur ne peut pas exécuter à la place de l'approbateur.
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.create_invited_admin('nouveau@transfertplus.example', 'Nouvel agent', ARRAY['10.0.0.0/8']::cidr[],
               ARRAY['support'], sha256('jeton-1'), now() + interval '72 hours')$q$,
        'BO001', 'exécution par le demandeur refusée');

    PERFORM set_config('app.actor_id', v_super_b::text, true);
    -- Une approbation ne vaut que pour sa cible.
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.create_invited_admin('autre@transfertplus.example', 'Autre agent', ARRAY['10.0.0.0/8']::cidr[],
               ARRAY['super_admin'], sha256('jeton-2'), now() + interval '72 hours')$q$,
        'BO001', 'approbation détournée vers une autre cible refusée');
    v_invited := backoffice.create_invited_admin('nouveau@transfertplus.example', 'Nouvel agent', ARRAY['10.0.0.0/8']::cidr[],
                                                 ARRAY['support'], sha256('jeton-1'), now() + interval '72 hours');
    UPDATE backoffice.approval_requests SET status = 'executed' WHERE id = v_request;
    PERFORM set_config('app.approval_request_id', '', true);
    PERFORM pg_temp.assert_true(
        (SELECT status = 'invited' AND invited_by_admin_id = v_super_b FROM backoffice.admin_users WHERE id = v_invited),
        'compte créé invité, au nom de l''approbateur');
    PERFORM pg_temp.assert_true(NOT backoffice.has_permission(v_invited, 'customers:read'), 'un compte invité n''a aucun droit');

    -- Activation : clé WebAuthn et invitation consommée exigées.
    PERFORM set_config('app.actor_type', 'system', true);
    PERFORM set_config('app.actor_id', 'admin-enrollment', true);
    UPDATE backoffice.admin_users SET password_hash = '$argon2id$v=19$enrolled' WHERE id = v_invited;
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_users SET status = 'active' WHERE id = %L$q$, v_invited),
        'LG007', 'activation sans clé refusée');
    INSERT INTO backoffice.webauthn_credentials (admin_user_id, credential_id, public_key_cose)
    VALUES (v_invited, '\xdeadbeef', '\x0102');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_users SET status = 'active' WHERE id = %L$q$, v_invited),
        'LG007', 'activation sans invitation consommée refusée');
    UPDATE backoffice.invitations SET consumed_at = now() WHERE admin_user_id = v_invited;
    UPDATE backoffice.admin_users SET status = 'active' WHERE id = v_invited;
    PERFORM pg_temp.assert_true(backoffice.has_permission(v_invited, 'customers:read'), 'compte actif avec son rôle');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.invitations SET consumed_at = clock_timestamp() WHERE admin_user_id = %L$q$, v_invited),
        'LG006', 'invitation à usage unique');

    -- Rétablissement d'un compte suspendu : double validation.
    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_super_a::text, true);
    UPDATE backoffice.admin_users SET status = 'suspended' WHERE id = v_invited;
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_users SET status = 'active' WHERE id = %L$q$, v_invited),
        'BO001', 'réactivation sans double validation refusée');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_users SET status = 'disabled', disabled_at = now() WHERE id = %L$q$, v_super_a),
        'BO002', 'désactivation de son propre compte refusée');
    PERFORM set_config('app.actor_id', v_support::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_users SET status = 'disabled', disabled_at = now() WHERE id = %L$q$, v_invited),
        'BO002', 'désactivation par un rôle non habilité refusée');

    -- Retrait de rôle : signé, jamais sur soi-même.
    PERFORM set_config('app.actor_id', v_super_a::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_user_roles SET revoked_at = now(), revoked_by_admin_id = %L
            WHERE admin_user_id = %L AND revoked_at IS NULL$q$, v_super_b, v_risk),
        'BO002', 'retrait de rôle au nom d''un autre refusé');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.admin_user_roles SET revoked_at = now(), revoked_by_admin_id = %L
            WHERE admin_user_id = %L AND revoked_at IS NULL$q$, v_super_a, v_super_a),
        'BO002', 'retrait de ses propres rôles refusé');

    -- -------------------------------------------------------------------------
    -- Registre : ajustement, contre-passation et gel sous double validation.
    -- -------------------------------------------------------------------------
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('admin-adjustment:test-1', 'adjustment',
               jsonb_build_array(pg_temp.line(%L, 'debit', 100, 'EUR'), pg_temp.line(%L, 'credit', 100, 'EUR')),
               'Correction', 'admin:test')$q$, pg_temp.id('alice_wallet_eur'), pg_temp.id('fee_eur')),
        'BO001', 'ajustement sans approbation refusé');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.post_journal('admin-fee:test-1', 'transfer_fee',
               jsonb_build_array(pg_temp.line(%L, 'debit', 100, 'EUR'), pg_temp.line(%L, 'credit', 100, 'EUR')),
               'Frais', 'admin:test')$q$, pg_temp.id('alice_wallet_eur'), pg_temp.id('fee_eur')),
        'BO002', 'le personnel ne passe que des ajustements');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.set_account_status(%L, 'frozen', 'Suspicion de fraude')$q$, pg_temp.id('alice_wallet_eur')),
        'BO001', 'gel sans approbation refusé');

    v_payload := jsonb_build_object('idempotency_key', 'admin-adjustment:test-1');
    INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload, payload_sha256,
                                              justification, requested_by_admin_id)
    VALUES ('ledger:adjust', 'ledger_adjustment', 'ledger_adjustment', 'admin-adjustment:test-1', v_payload,
            sha256(convert_to(v_payload::text, 'UTF8')), 'Frais de service omis par erreur', v_super_a)
    RETURNING id INTO v_request;
    UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = v_super_b WHERE id = v_request;
    PERFORM set_config('app.actor_id', v_super_b::text, true);
    PERFORM set_config('app.approval_request_id', v_request::text, true);
    v_journal := ledger.post_journal('admin-adjustment:test-1', 'adjustment',
        jsonb_build_array(pg_temp.line(pg_temp.id('alice_wallet_eur'), 'debit', 100, 'EUR'),
                          pg_temp.line(pg_temp.id('fee_eur'), 'credit', 100, 'EUR')),
        'Frais de service omis lors d''un transfert', 'admin:' || v_super_b);
    PERFORM pg_temp.assert_true(v_journal IS NOT NULL, 'ajustement approuvé passé par l''approbateur');
    PERFORM pg_temp.assert_error(format(
        $q$SELECT ledger.reverse_journal(%L, 'admin-reversal:test-1', 'Erreur de saisie', 'admin:test')$q$, v_journal),
        'BO001', 'contre-passation hors de la cible approuvée refusée');
    UPDATE backoffice.approval_requests SET status = 'executed' WHERE id = v_request;
    PERFORM set_config('app.approval_request_id', '', true);

    -- -------------------------------------------------------------------------
    -- Décisions humaines : permission et signature de l'auteur.
    -- -------------------------------------------------------------------------
    PERFORM set_config('app.actor_type', 'system', true);
    PERFORM set_config('app.actor_id', 'aml', true);
    INSERT INTO aml.alerts (user_id, rule_code, severity, score, details)
    VALUES (v_alice, 'VELOCITY_24H', 'medium', 50, '{}')
    RETURNING id INTO v_alert;

    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_support::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.alerts SET status = 'closed_false_positive', resolved_by_admin_id = %L,
              resolution_note = 'Activité cohérente avec le profil' WHERE id = %L$q$, v_support, v_alert),
        'BO002', 'clôture par un rôle non habilité refusée');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO aml.alerts (user_id, rule_code, severity, score, assigned_to_admin_id)
           VALUES (%L, 'MANUAL_REVIEW', 'high', 80, %L)$q$, v_alice, v_support),
        'BO002', 'mise en revue manuelle par un rôle non habilité refusée');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE identity.users SET status = 'suspended' WHERE id = %L$q$, v_alice),
        'BO002', 'suspension d''un client par le support refusée');

    PERFORM set_config('app.actor_id', v_risk::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.alerts SET status = 'closed_false_positive', resolved_by_admin_id = %L,
              resolution_note = 'Activité cohérente avec le profil' WHERE id = %L$q$, v_super_a, v_alert),
        'BO002', 'clôture signée au nom d''un autre refusée');
    UPDATE aml.alerts SET status = 'closed_false_positive', resolved_by_admin_id = v_risk,
                          resolution_note = 'Activité cohérente avec le profil' WHERE id = v_alert;

    UPDATE identity.users SET status = 'suspended' WHERE id = v_alice;
    PERFORM pg_temp.assert_true((SELECT suspended_at IS NOT NULL FROM identity.users WHERE id = v_alice), 'suspension horodatée');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE identity.users SET status = 'closed', closed_at = now() WHERE id = %L$q$, v_alice),
        'TR001', 'clôture d''un compte client hors périmètre du personnel');
    UPDATE identity.users SET status = 'active' WHERE id = v_alice;

    -- Dossier : ouvert au nom de son auteur ; déclaration de soupçon sous double validation.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO aml.cases (user_id, summary, opened_by_admin_id) VALUES (%L, 'Flux atypiques vers un tiers', %L)$q$,
        v_alice, v_super_a),
        'BO002', 'dossier ouvert au nom d''un autre refusé');
    INSERT INTO aml.cases (user_id, summary, opened_by_admin_id)
    VALUES (v_alice, 'Flux atypiques vers un tiers', v_risk)
    RETURNING id INTO v_case;
    INSERT INTO aml.case_alerts (case_id, alert_id) VALUES (v_case, v_alert);
    UPDATE aml.cases SET status = 'investigating' WHERE id = v_case;
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.cases SET status = 'sar_filed', sar_reference = 'TRACFIN-2026-001', sar_filed_at = now() WHERE id = %L$q$,
        v_case),
        'BO001', 'déclaration de soupçon sans double validation refusée');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE aml.cases SET status = 'open' WHERE id = %L$q$, v_case),
        'TR001', 'retour arrière d''un dossier refusé');

    PERFORM set_config('app.actor_type', '', true);
    PERFORM set_config('app.actor_id', '', true);

    -- Installation : premier super-administrateur refusé dès qu'un compte existe.
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.bootstrap_super_admin('premier@transfertplus.example', 'Premier', ARRAY['10.0.0.0/8']::cidr[],
               sha256('jeton-amorce'), now() + interval '24 hours')$q$,
        'BO002', 'amorçage refusé lorsque le personnel existe');
END;
$$;

-- Le rôle applicatif ne crée ni compte ni rôle directement, et n'amorce rien.
SET LOCAL ROLE app_api;
DO $$
BEGIN
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO backoffice.admin_users (email, full_name) VALUES ('pirate@transfertplus.example', 'Pirate')$q$,
        '42501', 'app_api ne crée pas de compte du personnel');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code) SELECT id, 'super_admin' FROM backoffice.admin_users LIMIT 1$q$,
        '42501', 'app_api n''attribue pas de rôle directement');
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.bootstrap_super_admin('pirate@transfertplus.example', 'Pirate', ARRAY['0.0.0.0/0']::cidr[],
               sha256('x'), now() + interval '1 hour')$q$,
        '42501', 'app_api n''amorce pas de super-administrateur');
END;
$$;
RESET ROLE;
