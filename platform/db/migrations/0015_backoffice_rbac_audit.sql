-- =============================================================================
-- 0015 — Back-office : personnel, RBAC, sessions admin, double validation
--        (règle des quatre yeux) et journal d'audit chaîné
--
-- Les comptes du personnel sont totalement séparés des comptes clients
-- (autre table, autre audience JWT, autre clé de signature, WebAuthn
-- obligatoire). La matrice rôles → permissions est versionnée ici, dans les
-- migrations, et non modifiable depuis l'interface d'administration.
-- =============================================================================

CREATE TABLE backoffice.admin_users (
    id                  uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- E-mail professionnel normalisé en minuscules.
    email               text                        NOT NULL UNIQUE,
    full_name           text                        NOT NULL,
    status              backoffice.admin_status     NOT NULL DEFAULT 'invited',
    password_hash       text,
    -- Plages d'adresses IP autorisées (VPN d'entreprise). Vide = refus total.
    allowed_ip_ranges   cidr[]                      NOT NULL DEFAULT '{}',
    failed_login_count  integer                     NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    last_login_at       timestamptz,
    invited_by_admin_id uuid                        REFERENCES backoffice.admin_users (id),
    created_at          timestamptz                 NOT NULL DEFAULT now(),
    updated_at          timestamptz                 NOT NULL DEFAULT now(),
    disabled_at         timestamptz,
    CONSTRAINT admin_users_email_normalized CHECK (
        email = lower(email) AND email ~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$'
    ),
    CONSTRAINT admin_users_password_argon2id CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
    CONSTRAINT admin_users_active_has_password CHECK (status <> 'active' OR password_hash IS NOT NULL),
    CONSTRAINT admin_users_disabled_date CHECK (status <> 'disabled' OR disabled_at IS NOT NULL),
    CONSTRAINT admin_users_failed_login CHECK (failed_login_count >= 0)
);

CREATE TRIGGER admin_users_set_updated_at
    BEFORE UPDATE ON backoffice.admin_users
    FOR EACH ROW EXECUTE FUNCTION util.set_updated_at();
CREATE TRIGGER admin_users_freeze_identity
    BEFORE UPDATE ON backoffice.admin_users
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'full_name', 'status', 'password_hash', 'allowed_ip_ranges', 'failed_login_count',
        'locked_until', 'last_login_at', 'updated_at', 'disabled_at'
    );
CREATE TRIGGER admin_users_forbid_delete
    BEFORE DELETE ON backoffice.admin_users
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Un compte désactivé ne peut pas être réactivé (nouvelle invitation requise).
CREATE FUNCTION backoffice.admin_users_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.admin_users : désactivation définitive';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_users_guard
    BEFORE UPDATE ON backoffice.admin_users
    FOR EACH ROW EXECUTE FUNCTION backoffice.admin_users_guard();

-- Clés WebAuthn du personnel (clés matérielles FIDO2 obligatoires).
CREATE TABLE backoffice.webauthn_credentials (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id       uuid        NOT NULL REFERENCES backoffice.admin_users (id),
    credential_id       bytea       NOT NULL UNIQUE,
    public_key_cose     bytea       NOT NULL,
    sign_count          bigint      NOT NULL DEFAULT 0,
    aaguid              uuid,
    -- Les passkeys synchronisées (backup_eligible) sont refusées pour le
    -- personnel : la clé doit rester liée à un authentificateur physique.
    backup_eligible     boolean     NOT NULL DEFAULT false,
    nickname            text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    revoked_at          timestamptz,
    CONSTRAINT admin_webauthn_sign_count CHECK (sign_count >= 0),
    CONSTRAINT admin_webauthn_device_bound CHECK (NOT backup_eligible)
);

CREATE INDEX admin_webauthn_user_idx ON backoffice.webauthn_credentials (admin_user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER admin_webauthn_freeze_identity
    BEFORE UPDATE ON backoffice.webauthn_credentials
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('sign_count', 'nickname', 'last_used_at', 'revoked_at');
CREATE TRIGGER admin_webauthn_forbid_delete
    BEFORE DELETE ON backoffice.webauthn_credentials
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE TABLE backoffice.sessions (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id       uuid        NOT NULL REFERENCES backoffice.admin_users (id),
    webauthn_credential_id uuid     NOT NULL REFERENCES backoffice.webauthn_credentials (id),
    ip_address          inet        NOT NULL,
    user_agent          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz NOT NULL DEFAULT now(),
    idle_expires_at     timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at          timestamptz,
    revoked_reason      text,
    CONSTRAINT admin_sessions_expiry CHECK (
        idle_expires_at > created_at
        AND idle_expires_at <= absolute_expires_at
        AND absolute_expires_at <= created_at + interval '12 hours'
    ),
    CONSTRAINT admin_sessions_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX admin_sessions_user_idx ON backoffice.sessions (admin_user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER admin_sessions_freeze_identity
    BEFORE UPDATE ON backoffice.sessions
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('last_used_at', 'idle_expires_at', 'revoked_at', 'revoked_reason');
CREATE TRIGGER admin_sessions_guard
    BEFORE UPDATE ON backoffice.sessions
    FOR EACH ROW EXECUTE FUNCTION identity.sessions_guard();
CREATE TRIGGER admin_sessions_forbid_delete
    BEFORE DELETE ON backoffice.sessions
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- -----------------------------------------------------------------------------
-- RBAC.
-- -----------------------------------------------------------------------------
CREATE TABLE backoffice.roles (
    code        text PRIMARY KEY,
    description text NOT NULL,
    CONSTRAINT roles_code_format CHECK (code ~ '^[a-z_]{2,50}$')
);

CREATE TABLE backoffice.permissions (
    code        text PRIMARY KEY,
    description text NOT NULL,
    -- Action sensible exigeant l'approbation d'un second membre du personnel.
    requires_four_eyes boolean NOT NULL DEFAULT false,
    CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z_]+:[a-z_]+(:[a-z_]+)?$')
);

CREATE TABLE backoffice.role_permissions (
    role_code       text NOT NULL REFERENCES backoffice.roles (code),
    permission_code text NOT NULL REFERENCES backoffice.permissions (code),
    PRIMARY KEY (role_code, permission_code)
);

INSERT INTO backoffice.roles (code, description) VALUES
    ('support',      'Support client : consultation des clients et transferts, aide de premier niveau'),
    ('risk_manager', 'Conformité / risques : décisions KYC, alertes AML, dossiers, gel de comptes'),
    ('super_admin',  'Administration de la plateforme : personnel, routage, tarification, ajustements');

INSERT INTO backoffice.permissions (code, description, requires_four_eyes) VALUES
    ('customers:read',          'Consulter les fiches clients (données masquées)',              false),
    ('customers:read_pii',      'Afficher les données personnelles déchiffrées',                false),
    ('customers:suspend',       'Suspendre ou réactiver un client',                             false),
    ('transfers:read',          'Consulter les transferts et leur historique',                  false),
    ('transfers:hold',          'Placer un transfert en revue de conformité',                   false),
    ('transfers:release',       'Libérer un transfert bloqué en revue',                         false),
    ('transfers:refund',        'Ordonner le remboursement d''un transfert',                    true),
    ('kyc:read',                'Consulter les vérifications KYC et documents',                 false),
    ('kyc:decide',              'Approuver ou rejeter une vérification KYC',                    false),
    ('aml:alerts:read',         'Consulter les alertes AML',                                    false),
    ('aml:alerts:manage',       'Traiter et clore les alertes AML',                             false),
    ('aml:cases:manage',        'Ouvrir et instruire les dossiers d''enquête',                  false),
    ('aml:sar:file',            'Déclarer un soupçon auprès de la cellule de renseignement',    true),
    ('ledger:read',             'Consulter le registre comptable',                              false),
    ('ledger:freeze',           'Geler ou dégeler un compte du registre',                       true),
    ('ledger:adjust',           'Passer une écriture d''ajustement ou une contre-passation',    true),
    ('routing:manage',          'Modifier corridors, prestataires et disjoncteurs',             true),
    ('pricing:manage',          'Modifier marges de change et barèmes de frais',                true),
    ('countries:manage',        'Ouvrir ou fermer un pays à l''envoi / la réception',           true),
    ('admins:manage',           'Inviter, désactiver le personnel et attribuer des rôles',      true),
    ('audit:read',              'Consulter le journal d''audit',                                false),
    ('approvals:decide',        'Approuver ou rejeter une demande en double validation',        false);

INSERT INTO backoffice.role_permissions (role_code, permission_code) VALUES
    ('support', 'customers:read'),
    ('support', 'transfers:read'),
    ('support', 'kyc:read'),

    ('risk_manager', 'customers:read'),
    ('risk_manager', 'customers:read_pii'),
    ('risk_manager', 'customers:suspend'),
    ('risk_manager', 'transfers:read'),
    ('risk_manager', 'transfers:hold'),
    ('risk_manager', 'transfers:release'),
    ('risk_manager', 'transfers:refund'),
    ('risk_manager', 'kyc:read'),
    ('risk_manager', 'kyc:decide'),
    ('risk_manager', 'aml:alerts:read'),
    ('risk_manager', 'aml:alerts:manage'),
    ('risk_manager', 'aml:cases:manage'),
    ('risk_manager', 'aml:sar:file'),
    ('risk_manager', 'ledger:read'),
    ('risk_manager', 'ledger:freeze'),
    ('risk_manager', 'audit:read'),
    ('risk_manager', 'approvals:decide');

-- super_admin reçoit toutes les permissions.
INSERT INTO backoffice.role_permissions (role_code, permission_code)
SELECT 'super_admin', p.code FROM backoffice.permissions p;

CREATE TRIGGER roles_immutable
    BEFORE UPDATE OR DELETE ON backoffice.roles
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER permissions_immutable
    BEFORE UPDATE OR DELETE ON backoffice.permissions
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER role_permissions_immutable
    BEFORE UPDATE OR DELETE ON backoffice.role_permissions
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE TABLE backoffice.admin_user_roles (
    admin_user_id       uuid        NOT NULL REFERENCES backoffice.admin_users (id),
    role_code           text        NOT NULL REFERENCES backoffice.roles (code),
    granted_by_admin_id uuid        REFERENCES backoffice.admin_users (id),
    granted_at          timestamptz NOT NULL DEFAULT now(),
    revoked_by_admin_id uuid        REFERENCES backoffice.admin_users (id),
    revoked_at          timestamptz,
    CONSTRAINT admin_user_roles_no_self_grant CHECK (granted_by_admin_id IS DISTINCT FROM admin_user_id),
    CONSTRAINT admin_user_roles_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_by_admin_id IS NULL))
);

-- Un rôle actif au plus une fois par personne ; l'historique des attributions
-- et retraits est conservé.
CREATE UNIQUE INDEX admin_user_roles_active_idx
    ON backoffice.admin_user_roles (admin_user_id, role_code)
    WHERE revoked_at IS NULL;

CREATE TRIGGER admin_user_roles_freeze_identity
    BEFORE UPDATE ON backoffice.admin_user_roles
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('revoked_by_admin_id', 'revoked_at');
CREATE TRIGGER admin_user_roles_forbid_delete
    BEFORE DELETE ON backoffice.admin_user_roles
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

-- Permissions effectives d'un membre du personnel actif.
CREATE VIEW backoffice.effective_permissions AS
SELECT DISTINCT ur.admin_user_id, rp.permission_code, p.requires_four_eyes
  FROM backoffice.admin_user_roles ur
  JOIN backoffice.admin_users u ON u.id = ur.admin_user_id
  JOIN backoffice.role_permissions rp ON rp.role_code = ur.role_code
  JOIN backoffice.permissions p ON p.code = rp.permission_code
 WHERE ur.revoked_at IS NULL
   AND u.status = 'active';

CREATE FUNCTION backoffice.has_permission(p_admin_user_id uuid, p_permission text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM backoffice.effective_permissions ep
         WHERE ep.admin_user_id = p_admin_user_id AND ep.permission_code = p_permission
    );
$$;

-- -----------------------------------------------------------------------------
-- Double validation (règle des quatre yeux). Le demandeur ne peut jamais
-- approuver sa propre demande ; l'approbateur doit détenir approvals:decide
-- ET la permission visée. Le contenu exact approuvé est figé par empreinte.
-- -----------------------------------------------------------------------------
CREATE TABLE backoffice.approval_requests (
    id                      uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_code         text                        NOT NULL REFERENCES backoffice.permissions (code),
    action_type             text                        NOT NULL,
    target_type             text                        NOT NULL,
    target_id               text                        NOT NULL,
    payload                 jsonb                       NOT NULL,
    payload_sha256          bytea                       NOT NULL,
    justification           text                        NOT NULL,
    status                  backoffice.approval_status  NOT NULL DEFAULT 'pending',
    requested_by_admin_id   uuid                        NOT NULL REFERENCES backoffice.admin_users (id),
    requested_at            timestamptz                 NOT NULL DEFAULT now(),
    decided_by_admin_id     uuid                        REFERENCES backoffice.admin_users (id),
    decided_at              timestamptz,
    decision_note           text,
    executed_at             timestamptz,
    expires_at              timestamptz                 NOT NULL DEFAULT now() + interval '24 hours',
    CONSTRAINT approval_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT approval_payload_hash CHECK (payload_sha256 = sha256(convert_to(payload::text, 'UTF8'))),
    CONSTRAINT approval_justification CHECK (char_length(justification) >= 10),
    CONSTRAINT approval_four_eyes CHECK (decided_by_admin_id IS DISTINCT FROM requested_by_admin_id),
    CONSTRAINT approval_decision CHECK (
        (status = 'pending' AND decided_at IS NULL AND decided_by_admin_id IS NULL)
        OR (status IN ('approved', 'rejected', 'executed') AND decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL)
        OR status = 'expired'
    ),
    CONSTRAINT approval_executed CHECK ((status = 'executed') = (executed_at IS NOT NULL)),
    CONSTRAINT approval_expiry CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '7 days')
);

CREATE INDEX approval_requests_pending_idx ON backoffice.approval_requests (requested_at) WHERE status = 'pending';

CREATE TRIGGER approval_requests_freeze_identity
    BEFORE UPDATE ON backoffice.approval_requests
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update(
        'status', 'decided_by_admin_id', 'decided_at', 'decision_note', 'executed_at'
    );
CREATE TRIGGER approval_requests_forbid_delete
    BEFORE DELETE ON backoffice.approval_requests
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION backoffice.approval_requests_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'approval_requests : une demande naît en attente';
        END IF;
        IF NOT backoffice.has_permission(NEW.requested_by_admin_id, NEW.permission_code) THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001',
                MESSAGE = format('approval_requests : le demandeur ne détient pas %s', NEW.permission_code);
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'expired'))
            OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'expired'))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'BO001',
                MESSAGE = format('approval_requests : transition %s → %s interdite', OLD.status, NEW.status);
        END IF;
        IF NEW.status IN ('approved', 'rejected') THEN
            IF OLD.expires_at <= now() THEN
                RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'approval_requests : demande expirée';
            END IF;
            IF NEW.decided_by_admin_id = OLD.requested_by_admin_id THEN
                RAISE EXCEPTION USING ERRCODE = 'BO001',
                    MESSAGE = 'approval_requests : le demandeur ne peut pas statuer sur sa propre demande';
            END IF;
            IF NOT backoffice.has_permission(NEW.decided_by_admin_id, 'approvals:decide')
               OR NOT backoffice.has_permission(NEW.decided_by_admin_id, OLD.permission_code) THEN
                RAISE EXCEPTION USING ERRCODE = 'BO001',
                    MESSAGE = 'approval_requests : l''approbateur n''a pas les permissions requises';
            END IF;
            NEW.decided_at := now();
        END IF;
        IF NEW.status = 'executed' THEN
            IF OLD.expires_at <= now() THEN
                RAISE EXCEPTION USING ERRCODE = 'BO001', MESSAGE = 'approval_requests : approbation expirée';
            END IF;
            NEW.executed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_guard
    BEFORE INSERT OR UPDATE ON backoffice.approval_requests
    FOR EACH ROW EXECUTE FUNCTION backoffice.approval_requests_guard();

-- -----------------------------------------------------------------------------
-- Clés étrangères vers le personnel, déclarées maintenant que la table existe.
-- -----------------------------------------------------------------------------
ALTER TABLE kyc.verifications
    ADD CONSTRAINT verifications_decided_by_fk FOREIGN KEY (decided_by_admin_id) REFERENCES backoffice.admin_users (id);
ALTER TABLE fx.pricing_rules
    ADD CONSTRAINT pricing_rules_created_by_fk FOREIGN KEY (created_by_admin_id) REFERENCES backoffice.admin_users (id);
ALTER TABLE transfers.fee_schedules
    ADD CONSTRAINT fee_schedules_created_by_fk FOREIGN KEY (created_by_admin_id) REFERENCES backoffice.admin_users (id);
ALTER TABLE aml.screenings
    ADD CONSTRAINT screenings_reviewed_by_fk FOREIGN KEY (reviewed_by_admin_id) REFERENCES backoffice.admin_users (id);
ALTER TABLE aml.alerts
    ADD CONSTRAINT alerts_assigned_to_fk FOREIGN KEY (assigned_to_admin_id) REFERENCES backoffice.admin_users (id),
    ADD CONSTRAINT alerts_resolved_by_fk FOREIGN KEY (resolved_by_admin_id) REFERENCES backoffice.admin_users (id);
ALTER TABLE aml.cases
    ADD CONSTRAINT cases_opened_by_fk FOREIGN KEY (opened_by_admin_id) REFERENCES backoffice.admin_users (id),
    ADD CONSTRAINT cases_assigned_to_fk FOREIGN KEY (assigned_to_admin_id) REFERENCES backoffice.admin_users (id);

-- =============================================================================
-- Journal d'audit : ajout seul, chaîné par empreintes comme le registre.
-- =============================================================================
CREATE TABLE audit.events (
    id              bigint              PRIMARY KEY,
    occurred_at     timestamptz         NOT NULL DEFAULT clock_timestamp(),
    actor_type      audit.actor_type    NOT NULL,
    actor_id        text,
    action          text                NOT NULL,
    target_type     text,
    target_id       text,
    ip_address      inet,
    user_agent      text,
    request_id      text,
    metadata        jsonb               NOT NULL DEFAULT '{}'::jsonb,
    prev_hash       bytea               NOT NULL,
    hash            bytea               NOT NULL UNIQUE,
    CONSTRAINT events_action_format CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
    CONSTRAINT events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT events_hash_len CHECK (octet_length(hash) = 32 AND octet_length(prev_hash) = 32),
    CONSTRAINT events_target_pair CHECK ((target_type IS NULL) = (target_id IS NULL))
);

CREATE INDEX events_actor_idx ON audit.events (actor_type, actor_id, occurred_at DESC);
CREATE INDEX events_target_idx ON audit.events (target_type, target_id, occurred_at DESC);
CREATE INDEX events_action_idx ON audit.events (action, occurred_at DESC);

CREATE TABLE audit.chain_head (
    singleton   boolean     PRIMARY KEY DEFAULT true,
    last_id     bigint      NOT NULL,
    last_hash   bytea       NOT NULL,
    CONSTRAINT audit_chain_head_singleton CHECK (singleton)
);

INSERT INTO audit.chain_head (singleton, last_id, last_hash) VALUES (true, 0, decode(repeat('00', 32), 'hex'));

CREATE FUNCTION audit.require_internal_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('audit.internal_write', true), '') <> 'on' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006',
            MESSAGE = format('%I.%I : écriture directe interdite, utiliser audit.record()', TG_TABLE_SCHEMA, TG_TABLE_NAME);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER events_internal_write_only
    BEFORE INSERT ON audit.events
    FOR EACH ROW EXECUTE FUNCTION audit.require_internal_write();
CREATE TRIGGER events_immutable
    BEFORE UPDATE OR DELETE ON audit.events
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();
CREATE TRIGGER events_no_truncate
    BEFORE TRUNCATE ON audit.events
    FOR EACH STATEMENT EXECUTE FUNCTION util.forbid_truncate();
CREATE TRIGGER audit_chain_head_internal_write_only
    BEFORE INSERT OR UPDATE ON audit.chain_head
    FOR EACH ROW EXECUTE FUNCTION audit.require_internal_write();
CREATE TRIGGER audit_chain_head_forbid_delete
    BEFORE DELETE ON audit.chain_head
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION audit.canonical_payload(
    p_id            bigint,
    p_occurred_at   timestamptz,
    p_actor_type    audit.actor_type,
    p_actor_id      text,
    p_action        text,
    p_target_type   text,
    p_target_id     text,
    p_ip_address    inet,
    p_request_id    text,
    p_metadata      jsonb
)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, pg_temp
AS $$
    SELECT ledger.lp('audit-v1')
        || ledger.lp(p_id::text)
        || ledger.lp(((extract(epoch FROM p_occurred_at) * 1000000)::bigint)::text)
        || ledger.lp(p_actor_type::text)
        || ledger.lp(p_actor_id)
        || ledger.lp(p_action)
        || ledger.lp(p_target_type)
        || ledger.lp(p_target_id)
        || ledger.lp(host(p_ip_address))
        || ledger.lp(p_request_id)
        || ledger.lp(p_metadata::text);
$$;

-- Enregistre un événement d'audit et l'ajoute à la chaîne. Retourne son id.
CREATE FUNCTION audit.record(
    p_actor_type    audit.actor_type,
    p_actor_id      text,
    p_action        text,
    p_target_type   text DEFAULT NULL,
    p_target_id     text DEFAULT NULL,
    p_ip_address    inet DEFAULT NULL,
    p_user_agent    text DEFAULT NULL,
    p_request_id    text DEFAULT NULL,
    p_metadata      jsonb DEFAULT '{}'::jsonb
)
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET lock_timeout = '5s'
AS $$
DECLARE
    v_head          record;
    v_id            bigint;
    v_occurred_at   timestamptz := clock_timestamp();
    v_metadata      jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_hash          bytea;
    v_previous_flag text := COALESCE(current_setting('audit.internal_write', true), '');
BEGIN
    SELECT h.last_id, h.last_hash INTO v_head FROM audit.chain_head h WHERE h.singleton FOR UPDATE;
    v_id := v_head.last_id + 1;
    v_hash := ledger.chain_hash(
        v_head.last_hash,
        audit.canonical_payload(v_id, v_occurred_at, p_actor_type, p_actor_id, p_action,
                                p_target_type, p_target_id, p_ip_address, p_request_id, v_metadata)
    );

    PERFORM set_config('audit.internal_write', 'on', true);
    INSERT INTO audit.events (id, occurred_at, actor_type, actor_id, action, target_type, target_id,
                              ip_address, user_agent, request_id, metadata, prev_hash, hash)
    VALUES (v_id, v_occurred_at, p_actor_type, p_actor_id, p_action, p_target_type, p_target_id,
            p_ip_address, p_user_agent, p_request_id, v_metadata, v_head.last_hash, v_hash);
    UPDATE audit.chain_head SET last_id = v_id, last_hash = v_hash WHERE singleton;
    PERFORM set_config('audit.internal_write', v_previous_flag, true);

    RETURN v_id;
END;
$$;

CREATE FUNCTION audit.verify_chain()
    RETURNS TABLE (event_id bigint, problem text)
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_event         record;
    v_expected_id   bigint := 1;
    v_expected_prev bytea := decode(repeat('00', 32), 'hex');
BEGIN
    FOR v_event IN SELECT e.* FROM audit.events e ORDER BY e.id LOOP
        IF v_event.id <> v_expected_id THEN
            event_id := v_expected_id; problem := format('trou dans la séquence (trouvé %s)', v_event.id);
            RETURN NEXT;
        END IF;
        IF v_event.prev_hash <> v_expected_prev THEN
            event_id := v_event.id; problem := 'prev_hash incohérent';
            RETURN NEXT;
        END IF;
        IF ledger.chain_hash(v_event.prev_hash, audit.canonical_payload(
               v_event.id, v_event.occurred_at, v_event.actor_type, v_event.actor_id, v_event.action,
               v_event.target_type, v_event.target_id, v_event.ip_address, v_event.request_id, v_event.metadata
           )) <> v_event.hash THEN
            event_id := v_event.id; problem := 'empreinte recalculée différente : événement altéré';
            RETURN NEXT;
        END IF;
        v_expected_prev := v_event.hash;
        v_expected_id := v_event.id + 1;
    END LOOP;
END;
$$;
