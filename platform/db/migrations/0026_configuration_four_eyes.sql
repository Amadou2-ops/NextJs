-- =============================================================================
-- 0026 — Paramétrage commercial et de routage sous double validation imposée
--        par la base.
--
-- Tables concernées : marges de change (fx.pricing_rules), barèmes de frais
-- (transfers.fee_schedules), corridors de paiement sortant
-- (payments.payout_corridors), moyens d'encaissement (payments.payin_methods),
-- activation des prestataires (payments.providers) et ouverture des pays
-- (ref.countries).
--
-- Qui peut écrire :
--   * le propriétaire des tables (migrations, données de référence,
--     exploitation en SQL) ;
--   * un membre du personnel, UNIQUEMENT en exécutant une demande approuvée
--     par un second membre (règle des quatre yeux), et la ligne écrite doit
--     être EXACTEMENT celle décrite par le contenu figé de la demande ;
--   * personne d'autre : le rôle applicatif hors back-office est refusé.
--
-- Une marge ou un barème publié reste immuable (0006, 0011) : on le clôt et on
-- en crée un nouveau. La clôture et la date d'effet ne sont jamais
-- rétroactives : un devis déjà émis garde ses conditions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Demande approuvée en cours d'exécution (sans contrôle de cible : chaque
-- garde vérifie la sienne, y compris le contenu).
-- -----------------------------------------------------------------------------
CREATE FUNCTION backoffice.approved_request(p_permission text)
    RETURNS backoffice.approval_requests
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin     uuid := backoffice.assert_actor_permission(p_permission);
    v_raw       text := NULLIF(current_setting('app.approval_request_id', true), '');
    v_request   backoffice.approval_requests;
BEGIN
    IF v_raw IS NULL OR v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : %s exige une demande approuvée par un second membre', p_permission);
    END IF;
    SELECT r.* INTO v_request FROM backoffice.approval_requests r WHERE r.id = v_raw::uuid;
    IF NOT FOUND
       OR v_request.status <> 'approved'
       OR v_request.permission_code <> p_permission
       OR v_request.expires_at <= now()
       OR v_request.decided_by_admin_id IS DISTINCT FROM v_admin
       OR v_request.requested_by_admin_id = v_admin THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : aucune approbation valide de %s', p_permission);
    END IF;
    RETURN v_request;
END;
$$;

-- Auteur d'une écriture de paramétrage : NULL pour le propriétaire de la
-- table, sinon la demande approuvée qu'il exécute (le reste est refusé).
-- SECURITY INVOKER : current_user est bien l'auteur de l'écriture.
CREATE FUNCTION backoffice.configuration_request(p_permission text, p_table regclass)
    RETURNS backoffice.approval_requests
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_none backoffice.approval_requests;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                WHERE c.oid = p_table AND pg_catalog.pg_get_userbyid(c.relowner) = current_user) THEN
        RETURN v_none;
    END IF;
    IF backoffice.current_admin_id() IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002',
            MESSAGE = format('%s : paramétrage réservé au personnel habilité (%s), sur demande approuvée', p_table, p_permission);
    END IF;
    RETURN backoffice.approved_request(p_permission);
END;
$$;

-- La demande exécutée est bien l'action attendue sur cette cible.
CREATE FUNCTION backoffice.assert_request_target(
    p_request       backoffice.approval_requests,
    p_action_types  text[],
    p_target_type   text,
    p_target_id     text
)
    RETURNS void
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT (p_request.action_type = ANY (p_action_types))
       OR p_request.target_type <> p_target_type
       OR p_request.target_id <> p_target_id THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : la demande %s (%s sur %s %s) n''autorise pas cette écriture sur %s %s',
                             p_request.id, p_request.action_type, p_request.target_type, p_request.target_id,
                             p_target_type, p_target_id);
    END IF;
END;
$$;

-- Chaque champ attendu existe dans le contenu approuvé et y a la même valeur
-- (comparaison sur la forme texte JSON : nombres, chaînes, booléens, null).
CREATE FUNCTION backoffice.assert_payload_matches(p_request backoffice.approval_requests, p_expected jsonb)
    RETURNS void
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_key   text;
    v_bad   text[] := '{}';
BEGIN
    FOR v_key IN SELECT jsonb_object_keys(p_expected) LOOP
        IF NOT (p_request.payload ? v_key)
           OR (p_request.payload ->> v_key) IS DISTINCT FROM (p_expected ->> v_key) THEN
            v_bad := v_bad || v_key;
        END IF;
    END LOOP;
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : écriture différente de la demande approuvée %s (%s)', p_request.id, array_to_string(v_bad, ', '));
    END IF;
END;
$$;

-- Date d'effet : celle de la demande, ou l'instant de l'exécution ; jamais passée.
CREATE FUNCTION backoffice.assert_effective_from(p_request backoffice.approval_requests, p_key text, p_value timestamptz)
    RETURNS void
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_expected timestamptz := COALESCE((p_request.payload ->> p_key)::timestamptz, now());
BEGIN
    IF p_value IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : date %s différente de la demande approuvée %s', p_key, p_request.id);
    END IF;
    IF p_value < now() THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : la date %s de la demande %s est dépassée (aucun effet rétroactif)', p_key, p_request.id);
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Règles datées (marges, barèmes) : création et clôture.
-- -----------------------------------------------------------------------------
CREATE FUNCTION backoffice.dated_rule_closure_guard(
    p_request       backoffice.approval_requests,
    p_close_action  text,
    p_create_action text,
    p_replaces_key  text,
    p_target_type   text,
    p_old_id        uuid,
    p_old_valid_to  timestamptz,
    p_new_valid_to  timestamptz
)
    RETURNS void
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_request.action_type = p_close_action THEN
        PERFORM backoffice.assert_request_target(p_request, ARRAY[p_close_action], p_target_type, p_old_id::text);
        PERFORM backoffice.assert_effective_from(p_request, 'validTo', p_new_valid_to);
    ELSIF p_request.action_type = p_create_action AND p_request.target_type = p_target_type
          AND (p_request.payload ->> p_replaces_key) = p_old_id::text THEN
        -- Remplacement : l'ancienne règle prend fin à la date d'effet de la nouvelle.
        PERFORM backoffice.assert_effective_from(p_request, 'validFrom', p_new_valid_to);
    ELSE
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : la demande %s n''autorise pas la clôture de %s %s', p_request.id, p_target_type, p_old_id);
    END IF;
    IF p_new_valid_to IS NULL OR (p_old_valid_to IS NOT NULL AND p_new_valid_to >= p_old_valid_to) THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : une clôture avance la fin de validité de %s %s, elle ne la repousse ni ne la retire', p_target_type, p_old_id);
    END IF;
END;
$$;

CREATE FUNCTION fx.pricing_rules_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('pricing:manage', 'fx.pricing_rules');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM backoffice.assert_request_target(v_request, ARRAY['create_pricing_rule'], 'pricing_rule', NEW.id::text);
        PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
            'sourceCurrency', NEW.source_currency,
            'destinationCurrency', NEW.destination_currency,
            'marginBps', NEW.margin_bps,
            'priority', NEW.priority));
        PERFORM backoffice.assert_effective_from(v_request, 'validFrom', NEW.valid_from);
        IF NEW.valid_to IS DISTINCT FROM (v_request.payload ->> 'validTo')::timestamptz THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'fx.pricing_rules : fin de validité différente de la demande approuvée';
        END IF;
        IF NEW.created_by_admin_id IS DISTINCT FROM v_request.requested_by_admin_id THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'fx.pricing_rules : l''auteur doit être le demandeur';
        END IF;
    ELSE
        PERFORM backoffice.dated_rule_closure_guard(v_request, 'close_pricing_rule', 'create_pricing_rule', 'replacesRuleId',
                                                    'pricing_rule', OLD.id, OLD.valid_to, NEW.valid_to);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_rules_configuration_guard
    BEFORE INSERT OR UPDATE ON fx.pricing_rules
    FOR EACH ROW EXECUTE FUNCTION fx.pricing_rules_configuration_guard();

CREATE FUNCTION transfers.fee_schedules_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('pricing:manage', 'transfers.fee_schedules');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM backoffice.assert_request_target(v_request, ARRAY['create_fee_schedule'], 'fee_schedule', NEW.id::text);
        PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
            'sourceCountry', NEW.source_country,
            'destinationCountry', NEW.destination_country,
            'sourceCurrency', NEW.source_currency,
            'destinationCurrency', NEW.destination_currency,
            'payoutMethod', NEW.payout_method,
            'fundingMethod', NEW.funding_method,
            'fixedFee', NEW.fixed_fee::text,
            'percentageBps', NEW.percentage_bps,
            'minFee', NEW.min_fee::text,
            'maxFee', NEW.max_fee::text,
            'priority', NEW.priority));
        PERFORM backoffice.assert_effective_from(v_request, 'validFrom', NEW.valid_from);
        IF NEW.valid_to IS DISTINCT FROM (v_request.payload ->> 'validTo')::timestamptz THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'transfers.fee_schedules : fin de validité différente de la demande approuvée';
        END IF;
        IF NEW.created_by_admin_id IS DISTINCT FROM v_request.requested_by_admin_id THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'transfers.fee_schedules : l''auteur doit être le demandeur';
        END IF;
    ELSE
        PERFORM backoffice.dated_rule_closure_guard(v_request, 'close_fee_schedule', 'create_fee_schedule', 'replacesScheduleId',
                                                    'fee_schedule', OLD.id, OLD.valid_to, NEW.valid_to);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fee_schedules_configuration_guard
    BEFORE INSERT OR UPDATE ON transfers.fee_schedules
    FOR EACH ROW EXECUTE FUNCTION transfers.fee_schedules_configuration_guard();

-- -----------------------------------------------------------------------------
-- Corridors de paiement sortant et moyens d'encaissement : la combinaison
-- (pays, devise, mode, prestataire) est figée ; seuls les paramètres changent.
-- -----------------------------------------------------------------------------
CREATE FUNCTION payments.payout_corridors_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('routing:manage', 'payments.payout_corridors');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM backoffice.assert_request_target(v_request, ARRAY['create_payout_corridor'], 'payout_corridor', NEW.id::text);
        PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
            'sourceCountry', NEW.source_country,
            'destinationCountry', NEW.destination_country,
            'destinationCurrency', NEW.destination_currency,
            'payoutMethod', NEW.payout_method,
            'provider', NEW.provider));
    ELSE
        PERFORM backoffice.assert_request_target(v_request, ARRAY['update_payout_corridor'], 'payout_corridor', OLD.id::text);
        IF (NEW.source_country, NEW.destination_country, NEW.destination_currency, NEW.payout_method, NEW.provider, NEW.created_at)
           IS DISTINCT FROM (OLD.source_country, OLD.destination_country, OLD.destination_currency, OLD.payout_method, OLD.provider, OLD.created_at) THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001',
                MESSAGE = 'payments.payout_corridors : pays, devise, mode et prestataire d''un corridor sont figés (créer un autre corridor)';
        END IF;
    END IF;
    PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
        'priority', NEW.priority,
        'minAmount', NEW.min_amount::text,
        'maxAmount', NEW.max_amount::text,
        'costFixed', NEW.cost_fixed::text,
        'costBps', NEW.cost_bps,
        'estimatedDeliveryMinutes', NEW.estimated_delivery_minutes,
        'isEnabled', NEW.is_enabled,
        'providerRouteCode', NEW.provider_route_code));
    RETURN NEW;
END;
$$;

CREATE TRIGGER payout_corridors_configuration_guard
    BEFORE INSERT OR UPDATE ON payments.payout_corridors
    FOR EACH ROW EXECUTE FUNCTION payments.payout_corridors_configuration_guard();

CREATE FUNCTION payments.payin_methods_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('routing:manage', 'payments.payin_methods');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM backoffice.assert_request_target(v_request, ARRAY['create_payin_method'], 'payin_method', NEW.id::text);
        PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
            'country', NEW.country,
            'currency', NEW.currency,
            'fundingMethod', NEW.funding_method,
            'provider', NEW.provider));
    ELSE
        PERFORM backoffice.assert_request_target(v_request, ARRAY['update_payin_method'], 'payin_method', OLD.id::text);
        IF (NEW.country, NEW.currency, NEW.funding_method, NEW.provider, NEW.created_at)
           IS DISTINCT FROM (OLD.country, OLD.currency, OLD.funding_method, OLD.provider, OLD.created_at) THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001',
                MESSAGE = 'payments.payin_methods : pays, devise, moyen et prestataire sont figés (créer un autre moyen)';
        END IF;
    END IF;
    PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
        'priority', NEW.priority,
        'minAmount', NEW.min_amount::text,
        'maxAmount', NEW.max_amount::text,
        'costFixed', NEW.cost_fixed::text,
        'costBps', NEW.cost_bps,
        'isEnabled', NEW.is_enabled));
    RETURN NEW;
END;
$$;

CREATE TRIGGER payin_methods_configuration_guard
    BEFORE INSERT OR UPDATE ON payments.payin_methods
    FOR EACH ROW EXECUTE FUNCTION payments.payin_methods_configuration_guard();

-- -----------------------------------------------------------------------------
-- Prestataires : activation seulement ; l'environnement (bac à sable / live)
-- ne change que par migration.
-- -----------------------------------------------------------------------------
CREATE FUNCTION payments.providers_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('routing:manage', 'payments.providers');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM backoffice.assert_request_target(v_request, ARRAY['set_payment_provider'], 'payment_provider', OLD.code::text);
    IF (NEW.display_name, NEW.environment) IS DISTINCT FROM (OLD.display_name, OLD.environment) THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = 'payments.providers : le nom et l''environnement d''un prestataire ne changent que par migration';
    END IF;
    PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object('isEnabled', NEW.is_enabled));
    RETURN NEW;
END;
$$;

CREATE TRIGGER providers_configuration_guard
    BEFORE UPDATE ON payments.providers
    FOR EACH ROW EXECUTE FUNCTION payments.providers_configuration_guard();

-- -----------------------------------------------------------------------------
-- Pays : ouverture à l'envoi / à la réception et niveau de risque (la
-- contrainte countries_prohibited_closed reste la dernière barrière).
-- -----------------------------------------------------------------------------
CREATE FUNCTION ref.countries_configuration_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_request backoffice.approval_requests := backoffice.configuration_request('countries:manage', 'ref.countries');
BEGIN
    IF v_request.id IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM backoffice.assert_request_target(v_request, ARRAY['update_country'], 'country', OLD.alpha2::text);
    PERFORM backoffice.assert_payload_matches(v_request, jsonb_build_object(
        'canSend', NEW.can_send,
        'canReceive', NEW.can_receive,
        'riskLevel', NEW.risk_level));
    IF NEW.risk_reviewed_at IS DISTINCT FROM now() THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'ref.countries : la revue est datée de son exécution';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER countries_configuration_guard
    BEFORE UPDATE ON ref.countries
    FOR EACH ROW EXECUTE FUNCTION ref.countries_configuration_guard();

-- -----------------------------------------------------------------------------
-- Consultation du paramétrage (sans modification) : conformité et administration.
-- -----------------------------------------------------------------------------
INSERT INTO backoffice.permissions (code, description, requires_four_eyes) VALUES
    ('configuration:read', 'Consulter corridors, tarification, prestataires et pays', false);
INSERT INTO backoffice.role_permissions (role_code, permission_code) VALUES
    ('risk_manager', 'configuration:read'),
    ('super_admin', 'configuration:read');

-- -----------------------------------------------------------------------------
-- Droits.
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION backoffice.approved_request(text),
                          backoffice.configuration_request(text, regclass),
                          backoffice.assert_request_target(backoffice.approval_requests, text[], text, text),
                          backoffice.assert_payload_matches(backoffice.approval_requests, jsonb),
                          backoffice.assert_effective_from(backoffice.approval_requests, text, timestamptz),
                          backoffice.dated_rule_closure_guard(backoffice.approval_requests, text, text, text, text, uuid, timestamptz, timestamptz)
    TO app_api;
-- Lecture du paramétrage par les auditeurs.
GRANT SELECT ON fx.pricing_rules, transfers.fee_schedules, payments.payout_corridors, payments.payin_methods, payments.providers
    TO app_auditor;
