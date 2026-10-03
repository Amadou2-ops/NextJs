-- =============================================================================
-- Back-office : RBAC, règle des quatre yeux, journal d'audit chaîné ; KYC.
-- =============================================================================
DO $$
DECLARE
    v_support       uuid;
    v_risk_a        uuid;
    v_risk_b        uuid;
    v_request       uuid;
    v_payload       jsonb := '{"account_id": "00000000-0000-0000-0000-000000000001", "status": "frozen"}';
    v_verification  uuid;
    v_event         bigint;
BEGIN
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
    VALUES ('support@transfertplus.example', 'Agent Support', 'active', '$argon2id$v=19$fixture')
    RETURNING id INTO v_support;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
    VALUES ('risk.a@transfertplus.example', 'Analyste Risque A', 'active', '$argon2id$v=19$fixture')
    RETURNING id INTO v_risk_a;
    INSERT INTO backoffice.admin_users (email, full_name, status, password_hash)
    VALUES ('risk.b@transfertplus.example', 'Analyste Risque B', 'active', '$argon2id$v=19$fixture')
    RETURNING id INTO v_risk_b;

    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id) VALUES
        (v_support, 'support', v_risk_a),
        (v_risk_a, 'risk_manager', v_risk_b),
        (v_risk_b, 'risk_manager', v_risk_a);

    -- Matrice RBAC.
    PERFORM pg_temp.assert_true(backoffice.has_permission(v_support, 'transfers:read'), 'support lit les transferts');
    PERFORM pg_temp.assert_true(NOT backoffice.has_permission(v_support, 'kyc:decide'), 'support ne décide pas du KYC');
    PERFORM pg_temp.assert_true(NOT backoffice.has_permission(v_support, 'customers:read_pii'), 'support ne voit pas les PII');
    PERFORM pg_temp.assert_true(backoffice.has_permission(v_risk_a, 'kyc:decide'), 'risk_manager décide du KYC');
    PERFORM pg_temp.assert_true(NOT backoffice.has_permission(v_risk_a, 'ledger:adjust'), 'risk_manager n''ajuste pas le registre');
    PERFORM pg_temp.assert_true(
        (SELECT count(*) FROM backoffice.role_permissions WHERE role_code = 'super_admin')
        = (SELECT count(*) FROM backoffice.permissions),
        'super_admin détient toutes les permissions');

    -- Auto-attribution d'un rôle interdite.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id)
           VALUES (%1$L, 'super_admin', %1$L)$q$, v_support),
        '23514', 'auto-attribution d''un rôle refusée');

    -- Un support ne peut pas initier une demande hors de ses permissions.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload,
               payload_sha256, justification, requested_by_admin_id)
           VALUES ('ledger:freeze', 'freeze_account', 'ledger_account', 'x', %L::jsonb,
               sha256(convert_to(%L::jsonb::text, 'UTF8')), 'Suspicion de fraude documentée', %L)$q$,
        v_payload, v_payload, v_support),
        'BO001', 'demande hors permissions refusée');

    -- Empreinte du contenu incohérente : refusée.
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload,
               payload_sha256, justification, requested_by_admin_id)
           VALUES ('ledger:freeze', 'freeze_account', 'ledger_account', 'x', %L::jsonb,
               sha256('autre chose'::bytea), 'Suspicion de fraude documentée', %L)$q$,
        v_payload, v_risk_a),
        '23514', 'empreinte du contenu approuvé vérifiée');

    INSERT INTO backoffice.approval_requests (permission_code, action_type, target_type, target_id, payload,
                                              payload_sha256, justification, requested_by_admin_id)
    VALUES ('ledger:freeze', 'freeze_account', 'ledger_account', 'x', v_payload,
            sha256(convert_to(v_payload::text, 'UTF8')), 'Suspicion de fraude documentée', v_risk_a)
    RETURNING id INTO v_request;

    -- Le demandeur ne peut pas approuver sa propre demande.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = %L WHERE id = %L$q$,
        v_risk_a, v_request), 'BO001', 'auto-approbation refusée');
    -- Un approbateur sans la permission visée ne peut pas approuver.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = %L WHERE id = %L$q$,
        v_support, v_request), 'BO001', 'approbation par un rôle insuffisant refusée');
    -- Exécution avant approbation interdite.
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.approval_requests SET status = 'executed' WHERE id = %L$q$, v_request),
        'BO001', 'exécution sans approbation refusée');

    UPDATE backoffice.approval_requests SET status = 'approved', decided_by_admin_id = v_risk_b WHERE id = v_request;
    UPDATE backoffice.approval_requests SET status = 'executed' WHERE id = v_request;
    PERFORM pg_temp.assert_true(
        (SELECT decided_at IS NOT NULL AND executed_at IS NOT NULL FROM backoffice.approval_requests WHERE id = v_request),
        'approbation puis exécution horodatées');
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE backoffice.approval_requests SET payload = '{}'::jsonb WHERE id = %L$q$, v_request),
        'LG006', 'contenu approuvé figé');

    -- Journal d'audit chaîné.
    v_event := audit.record('admin', v_risk_b::text, 'approval.approved', 'approval_request', v_request::text,
                            '203.0.113.7', 'Mozilla/5.0', 'req-123', jsonb_build_object('permission', 'ledger:freeze'));
    PERFORM audit.record('admin', v_risk_a::text, 'approval.executed', 'approval_request', v_request::text);
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM audit.verify_chain()), 'chaîne d''audit intacte');
    PERFORM pg_temp.assert_error(format('UPDATE audit.events SET action = ''x.y'' WHERE id = %s', v_event),
        'LG006', 'événement d''audit immuable');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO audit.events (id, actor_type, action, prev_hash, hash)
           VALUES (999, 'system', 'forged.event', decode(repeat('00', 32), 'hex'), decode(repeat('11', 32), 'hex'))$q$,
        'LG006', 'insertion directe dans l''audit refusée');

    -- KYC : machine à états et historique automatique.
    PERFORM set_config('app.actor_type', 'provider', true);
    PERFORM set_config('app.actor_id', 'smile_id', true);
    INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference)
    VALUES (pg_temp.id('bob'), 'smile_id', 'biometric_kyc', 'tier_2', 'job-0001')
    RETURNING id INTO v_verification;
    UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = v_verification;

    PERFORM pg_temp.assert_error(format(
        $q$UPDATE kyc.verifications SET status = 'created' WHERE id = %L$q$, v_verification),
        'TR001', 'retour arrière KYC interdit');

    PERFORM set_config('app.actor_type', 'admin', true);
    PERFORM set_config('app.actor_id', v_risk_a::text, true);
    PERFORM pg_temp.assert_error(format(
        $q$UPDATE kyc.verifications SET status = 'approved', decided_at = now(), expires_at = now() + interval '1 year'
            WHERE id = %L$q$, v_verification),
        'LG007', 'décision manuelle sans identification de l''analyste refusée');
    UPDATE kyc.verifications
       SET status = 'approved', decided_at = now(), decided_by_admin_id = v_risk_a,
           expires_at = now() + interval '2 years'
     WHERE id = v_verification;

    PERFORM pg_temp.assert_true(
        (SELECT array_agg(to_status::text ORDER BY id) FROM kyc.review_events WHERE verification_id = v_verification)
        = ARRAY['created', 'submitted', 'approved'],
        'historique KYC complet');
END;
$$;
