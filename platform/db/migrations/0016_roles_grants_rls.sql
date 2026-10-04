-- =============================================================================
-- 0016 — Rôles, privilèges au plus juste, sécurité au niveau des lignes (RLS)
--
-- Rôles de groupe (NOLOGIN). Les identifiants de connexion réels sont créés
-- par l'exploitation, par environnement, et rattachés à ces groupes :
--   CREATE ROLE api_prod LOGIN PASSWORD '...' IN ROLE app_api;
--
--   app_api       API Node.js et workers. Aucun droit d'écriture direct sur le
--                 registre : uniquement EXECUTE sur ses fonctions publiques.
--   app_readonly  Lecture analytique / support N2, sans aucun secret
--                 d'authentification.
--   app_auditor   Auditeurs externes : registre, audit, transferts, AML et
--                 fonctions de vérification d'intégrité.
--
-- Sur Supabase, les rôles anon / authenticated / service_role n'ont aucun
-- accès à ces schémas (révocation explicite ci-dessous) et PostgREST ne les
-- expose pas.
-- =============================================================================

DO $$
DECLARE
    v_role text;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['app_api', 'app_readonly', 'app_auditor'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION', v_role);
        END IF;
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Fonctions de trigger écrivant dans des tables d'historique ou consommant un
-- devis : exécutées avec les droits du propriétaire, afin que le rôle
-- applicatif n'ait AUCUN droit d'écriture direct sur ces tables (impossible de
-- forger une ligne d'historique ou de consommer un devis hors transfert).
-- -----------------------------------------------------------------------------
ALTER FUNCTION kyc.verifications_record_history() SECURITY DEFINER;
ALTER FUNCTION transfers.transfers_guard() SECURITY DEFINER;
ALTER FUNCTION transfers.transfers_record_history() SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- Par défaut, PostgreSQL accorde EXECUTE à PUBLIC sur toute fonction : on
-- retire ce droit partout, maintenant et pour les fonctions futures.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_schema text;
BEGIN
    FOREACH v_schema IN ARRAY ARRAY['util', 'ref', 'identity', 'kyc', 'fx', 'ledger', 'transfers',
                                    'payments', 'integrations', 'aml', 'backoffice', 'audit'] LOOP
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', v_schema);
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', v_schema);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', v_schema);
        EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', v_schema);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', v_schema);

        -- Rôles Supabase : aucun accès.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated', v_schema);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon, authenticated', v_schema);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon, authenticated', v_schema);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM anon, authenticated', v_schema);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('REVOKE ALL ON SCHEMA %I FROM service_role', v_schema);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM service_role', v_schema);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM service_role', v_schema);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM service_role', v_schema);
        END IF;

        -- Accès aux schémas pour nos rôles.
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_api, app_readonly', v_schema);
        -- Les fonctions utilitaires appelées par les triggers s'exécutent avec
        -- les droits de l'appelant : app_api doit pouvoir les exécuter.
        EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO app_api', v_schema);
        EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO app_api', v_schema);
    END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA util, ref, ledger, transfers, aml, audit, payments TO app_auditor;

-- Le cœur interne du registre n'est JAMAIS appelable directement.
REVOKE EXECUTE ON FUNCTION ledger._post_journal(text, ledger.journal_type, jsonb, text, text, text, uuid, jsonb, timestamptz, uuid)
    FROM app_api;

-- =============================================================================
-- app_api
-- =============================================================================

-- ref : lecture ; ouverture/fermeture de pays et devises (back-office).
GRANT SELECT ON ALL TABLES IN SCHEMA ref TO app_api;
GRANT UPDATE (is_enabled) ON ref.currencies TO app_api;
GRANT UPDATE (risk_level, can_send, can_receive, risk_reviewed_at) ON ref.countries TO app_api;

-- identity
GRANT SELECT, INSERT, UPDATE ON identity.users, identity.devices, identity.webauthn_credentials,
                                identity.sessions, identity.refresh_tokens, identity.otp_challenges
    TO app_api;

-- kyc : l'historique de revue est écrit uniquement par trigger.
GRANT SELECT, INSERT, UPDATE ON kyc.verifications TO app_api;
GRANT SELECT, INSERT ON kyc.documents TO app_api;
GRANT SELECT ON kyc.review_events, kyc.allowed_transitions, kyc.tier_limits TO app_api;
GRANT UPDATE (single_transfer_max, daily_max, monthly_max, annual_max) ON kyc.tier_limits TO app_api;

-- fx : un devis n'est consommé que par la création d'un transfert.
GRANT SELECT, INSERT ON fx.rate_snapshots, fx.quotes TO app_api;
GRANT SELECT ON fx.latest_rates TO app_api;
GRANT SELECT, INSERT ON fx.pricing_rules TO app_api;
GRANT UPDATE (valid_to) ON fx.pricing_rules TO app_api;

-- ledger : lecture seule + fonctions publiques (déjà accordées ci-dessus).
GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO app_api;
GRANT INSERT ON ledger.chain_anchors TO app_api;

-- transfers : l'historique des statuts est écrit uniquement par trigger.
GRANT SELECT, INSERT ON transfers.recipients TO app_api;
GRANT UPDATE (relationship, archived_at) ON transfers.recipients TO app_api;
GRANT SELECT, INSERT ON transfers.fee_schedules TO app_api;
GRANT UPDATE (valid_to) ON transfers.fee_schedules TO app_api;
GRANT SELECT, INSERT ON transfers.transfers TO app_api;
GRANT UPDATE (status, status_reason) ON transfers.transfers TO app_api;
GRANT SELECT ON transfers.status_history, transfers.allowed_transitions TO app_api;

-- payments
GRANT SELECT ON payments.providers, payments.attempt_transitions TO app_api;
GRANT UPDATE (is_enabled) ON payments.providers TO app_api;
GRANT SELECT, INSERT, UPDATE ON payments.payout_corridors, payments.payin_methods TO app_api;
GRANT SELECT, UPDATE ON payments.provider_health TO app_api;
GRANT SELECT, INSERT ON payments.attempts TO app_api;
GRANT UPDATE (provider_reference, status, failure_code, failure_message, provider_response, ledger_journal_id)
    ON payments.attempts TO app_api;

-- integrations
GRANT SELECT, INSERT ON integrations.webhook_events TO app_api;
GRANT UPDATE (status, attempts, last_error, locked_until, processed_at) ON integrations.webhook_events TO app_api;
GRANT SELECT, INSERT ON integrations.webhook_rejections TO app_api;
GRANT SELECT, INSERT ON integrations.outbox TO app_api;
GRANT UPDATE (status, attempts, available_at, locked_by, locked_until, last_error, published_at)
    ON integrations.outbox TO app_api;
GRANT SELECT, INSERT ON integrations.http_idempotency_keys TO app_api;
GRANT UPDATE (response_status, response_body, locked_until, completed_at)
    ON integrations.http_idempotency_keys TO app_api;

-- aml
GRANT SELECT ON aml.rules TO app_api;
GRANT UPDATE (is_enabled, severity, parameters, blocks_transfer) ON aml.rules TO app_api;
GRANT SELECT, INSERT, UPDATE ON aml.customer_risk_profiles, aml.screenings, aml.alerts, aml.cases TO app_api;
GRANT SELECT, INSERT ON aml.case_alerts TO app_api;

-- backoffice : la matrice RBAC est en lecture seule.
GRANT SELECT ON backoffice.roles, backoffice.permissions, backoffice.role_permissions,
                backoffice.effective_permissions TO app_api;
GRANT SELECT, INSERT, UPDATE ON backoffice.admin_users, backoffice.webauthn_credentials,
                                backoffice.sessions, backoffice.admin_user_roles,
                                backoffice.approval_requests TO app_api;

-- audit : écriture uniquement via audit.record().
GRANT SELECT ON audit.events TO app_api;

-- =============================================================================
-- app_readonly : tout en lecture, sauf secrets d'authentification.
-- =============================================================================
DO $$
DECLARE
    v_schema text;
BEGIN
    FOREACH v_schema IN ARRAY ARRAY['ref', 'identity', 'kyc', 'fx', 'ledger', 'transfers',
                                    'payments', 'integrations', 'aml', 'backoffice', 'audit'] LOOP
        EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO app_readonly', v_schema);
    END LOOP;
END;
$$;

REVOKE SELECT ON identity.refresh_tokens, identity.otp_challenges, identity.users,
                 backoffice.sessions, backoffice.admin_users, integrations.http_idempotency_keys,
                 ledger.chain_head, audit.chain_head
    FROM app_readonly;

GRANT SELECT (id, customer_number, status, phone_country, phone_verified_at, email_verified_at,
              nationality, country_of_residence, kyc_tier, preferred_locale, mfa_totp_enabled_at,
              failed_login_count, locked_until, last_login_at, created_at, updated_at,
              suspended_at, closed_at)
    ON identity.users TO app_readonly;
GRANT SELECT (id, email, full_name, status, last_login_at, created_at, updated_at, disabled_at)
    ON backoffice.admin_users TO app_readonly;

-- =============================================================================
-- app_auditor
-- =============================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO app_auditor;
GRANT SELECT ON audit.events TO app_auditor;
GRANT SELECT ON transfers.transfers, transfers.status_history TO app_auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA aml TO app_auditor;
GRANT SELECT ON ref.currencies, ref.countries TO app_auditor;
GRANT SELECT ON payments.attempts TO app_auditor;
GRANT EXECUTE ON FUNCTION ledger.verify_chain(bigint, bigint), ledger.verify_balances(),
                          ledger.lp(text), ledger.chain_hash(bytea, text),
                          ledger.canonical_payload(uuid, bigint, ledger.journal_type, text, text, uuid, uuid,
                                                   text, jsonb, text, timestamptz),
                          audit.verify_chain(), audit.canonical_payload(bigint, timestamptz, audit.actor_type,
                                                   text, text, text, text, inet, text, jsonb)
    TO app_auditor;

-- =============================================================================
-- RLS : activée sur toutes les tables. Le propriétaire (migrations, fonctions
-- SECURITY DEFINER) n'est pas soumis à RLS ; tout autre rôle sans politique
-- explicite ne voit aucune ligne.
-- =============================================================================
DO $$
DECLARE
    v_table record;
BEGIN
    FOR v_table IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p')
           AND n.nspname IN ('ref', 'identity', 'kyc', 'fx', 'ledger', 'transfers',
                             'payments', 'integrations', 'aml', 'backoffice', 'audit')
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_table.schema_name, v_table.table_name);
        EXECUTE format('CREATE POLICY app_api_all ON %I.%I FOR ALL TO app_api USING (true) WITH CHECK (true)',
                       v_table.schema_name, v_table.table_name);
        EXECUTE format('CREATE POLICY app_readonly_select ON %I.%I FOR SELECT TO app_readonly USING (true)',
                       v_table.schema_name, v_table.table_name);
        EXECUTE format('CREATE POLICY app_auditor_select ON %I.%I FOR SELECT TO app_auditor USING (true)',
                       v_table.schema_name, v_table.table_name);
    END LOOP;
END;
$$;

-- Les vues s'exécutent avec les droits de l'appelant (RLS et privilèges de
-- l'appelant appliqués), pas avec ceux de leur propriétaire.
ALTER VIEW fx.latest_rates SET (security_invoker = true);
ALTER VIEW ledger.trial_balance SET (security_invoker = true);
ALTER VIEW ledger.customer_balances SET (security_invoker = true);
ALTER VIEW backoffice.effective_permissions SET (security_invoker = true);
