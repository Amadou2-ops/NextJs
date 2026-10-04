-- =============================================================================
-- 0023 — Back-office opérationnel : authentification du personnel,
--        habilitations et double validation imposées par la base.
--
--   * Invitations à usage unique, défis WebAuthn et jetons de renouvellement
--     du personnel (empreintes SHA-256 seulement).
--   * Un compte du personnel ne devient actif qu'avec une clé WebAuthn
--     enregistrée ; création de comptes et attribution de rôles uniquement
--     via des fonctions qui exigent une demande approuvée (quatre yeux).
--   * Toute décision humaine (KYC, alertes AML, libération, mise en revue,
--     suspension d'un client) vérifie en base que l'acteur déclaré est un
--     membre actif du personnel détenant la permission requise.
--   * Les actions à double validation (ajustement et contre-passation du
--     registre, gel de compte, remboursement ordonné, déclaration de soupçon)
--     exigent en base une demande approuvée par un autre membre, exécutée
--     par son approbateur, sur la cible exacte de la demande.
--   * Mise en revue manuelle d'un transfert (règle MANUAL_REVIEW).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Acteur courant et contrôles d'habilitation.
-- -----------------------------------------------------------------------------

-- Identifiant du membre du personnel déclaré par la transaction, ou NULL si
-- l'acteur n'est pas un membre du personnel.
CREATE FUNCTION backoffice.current_admin_id()
    RETURNS uuid
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_type text := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system');
    v_id   text := NULLIF(current_setting('app.actor_id', true), '');
BEGIN
    IF v_type <> 'admin' THEN
        RETURN NULL;
    END IF;
    IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'backoffice : acteur du personnel non identifié';
    END IF;
    RETURN v_id::uuid;
END;
$$;

-- L'acteur doit être un membre actif du personnel détenant la permission.
CREATE FUNCTION backoffice.assert_actor_permission(p_permission text)
    RETURNS uuid
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid := backoffice.current_admin_id();
BEGIN
    IF v_admin IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002',
            MESSAGE = format('backoffice : action réservée au personnel habilité (%s)', p_permission);
    END IF;
    IF NOT backoffice.has_permission(v_admin, p_permission) THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002',
            MESSAGE = format('backoffice : %s ne détient pas %s', v_admin, p_permission);
    END IF;
    RETURN v_admin;
END;
$$;

-- L'action en cours exécute une demande approuvée (app.approval_request_id)
-- portant sur cette permission et cette cible ; l'acteur est son approbateur.
CREATE FUNCTION backoffice.assert_approved(p_permission text, p_target_type text, p_target_id text)
    RETURNS uuid
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin     uuid := backoffice.assert_actor_permission(p_permission);
    v_raw       text := NULLIF(current_setting('app.approval_request_id', true), '');
    v_request   record;
BEGIN
    IF v_raw IS NULL OR v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : %s exige une demande approuvée par un second membre', p_permission);
    END IF;
    SELECT r.* INTO v_request FROM backoffice.approval_requests r WHERE r.id = v_raw::uuid;
    IF NOT FOUND
       OR v_request.status <> 'approved'
       OR v_request.permission_code <> p_permission
       OR v_request.target_type <> p_target_type
       OR v_request.target_id <> p_target_id
       OR v_request.expires_at <= now()
       OR v_request.decided_by_admin_id IS DISTINCT FROM v_admin
       OR v_request.requested_by_admin_id = v_admin THEN
        RAISE EXCEPTION USING ERRCODE = 'BO001',
            MESSAGE = format('backoffice : aucune approbation valide de %s sur %s %s', p_permission, p_target_type, p_target_id);
    END IF;
    RETURN v_request.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Invitations, défis WebAuthn et jetons de renouvellement du personnel.
-- -----------------------------------------------------------------------------
CREATE TABLE backoffice.invitations (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id       uuid        NOT NULL REFERENCES backoffice.admin_users (id),
    token_sha256        bytea       NOT NULL UNIQUE,
    created_by_admin_id uuid        REFERENCES backoffice.admin_users (id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    revoked_at          timestamptz,
    CONSTRAINT invitations_hash_len CHECK (octet_length(token_sha256) = 32),
    CONSTRAINT invitations_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),
    CONSTRAINT invitations_single_outcome CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX invitations_open_idx ON backoffice.invitations (admin_user_id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER invitations_freeze_identity
    BEFORE UPDATE ON backoffice.invitations
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at', 'revoked_at');
CREATE TRIGGER invitations_forbid_delete
    BEFORE DELETE ON backoffice.invitations
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION backoffice.invitations_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF (OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.invitations : invitation déjà utilisée ou révoquée';
    END IF;
    IF NEW.consumed_at IS NOT NULL AND OLD.expires_at <= now() THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.invitations : invitation expirée';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_guard
    BEFORE UPDATE ON backoffice.invitations
    FOR EACH ROW EXECUTE FUNCTION backoffice.invitations_guard();

CREATE TABLE backoffice.webauthn_challenges (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id   uuid        NOT NULL REFERENCES backoffice.admin_users (id),
    ceremony        text        NOT NULL,
    challenge       text        NOT NULL,
    invitation_id   uuid        REFERENCES backoffice.invitations (id),
    ip_address      inet        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    CONSTRAINT admin_challenges_ceremony CHECK (ceremony IN ('registration', 'authentication')),
    CONSTRAINT admin_challenges_registration_invitation CHECK ((ceremony = 'registration') = (invitation_id IS NOT NULL)),
    CONSTRAINT admin_challenges_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
    CONSTRAINT admin_challenges_format CHECK (challenge ~ '^[A-Za-z0-9_-]{32,128}$')
);

CREATE INDEX admin_challenges_user_idx ON backoffice.webauthn_challenges (admin_user_id, created_at DESC);

CREATE TRIGGER admin_challenges_freeze_identity
    BEFORE UPDATE ON backoffice.webauthn_challenges
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at');
CREATE TRIGGER admin_challenges_forbid_delete
    BEFORE DELETE ON backoffice.webauthn_challenges
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION backoffice.webauthn_challenges_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.webauthn_challenges : défi déjà consommé';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_challenges_guard
    BEFORE UPDATE ON backoffice.webauthn_challenges
    FOR EACH ROW EXECUTE FUNCTION backoffice.webauthn_challenges_guard();

CREATE TABLE backoffice.refresh_tokens (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid        NOT NULL REFERENCES backoffice.sessions (id),
    parent_id       uuid        REFERENCES backoffice.refresh_tokens (id),
    token_sha256    bytea       NOT NULL UNIQUE,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    CONSTRAINT admin_refresh_hash_len CHECK (octet_length(token_sha256) = 32),
    CONSTRAINT admin_refresh_expiry CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '12 hours')
);

-- Un jeton n'a qu'un successeur : deux renouvellements concurrents ne
-- peuvent pas réussir tous les deux.
CREATE UNIQUE INDEX admin_refresh_single_child_idx ON backoffice.refresh_tokens (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX admin_refresh_session_idx ON backoffice.refresh_tokens (session_id);

CREATE TRIGGER admin_refresh_freeze_identity
    BEFORE UPDATE ON backoffice.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION util.restrict_update('consumed_at');
CREATE TRIGGER admin_refresh_forbid_delete
    BEFORE DELETE ON backoffice.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION util.forbid_mutation();

CREATE FUNCTION backoffice.refresh_tokens_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.refresh_tokens : jeton déjà consommé';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_refresh_guard
    BEFORE UPDATE ON backoffice.refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION backoffice.refresh_tokens_guard();

-- -----------------------------------------------------------------------------
-- Comptes du personnel.
-- -----------------------------------------------------------------------------
CREATE FUNCTION backoffice.admin_users_operations_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor uuid := backoffice.current_admin_id();
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status = 'invited' AND NEW.status = 'active' THEN
            -- Activation : clé matérielle enregistrée et invitation consommée.
            IF NOT EXISTS (
                SELECT 1 FROM backoffice.webauthn_credentials c
                 WHERE c.admin_user_id = NEW.id AND c.revoked_at IS NULL
            ) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007',
                    MESSAGE = 'backoffice.admin_users : activation impossible sans clé WebAuthn';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM backoffice.invitations i
                 WHERE i.admin_user_id = NEW.id AND i.consumed_at IS NOT NULL
            ) THEN
                RAISE EXCEPTION USING ERRCODE = 'LG007',
                    MESSAGE = 'backoffice.admin_users : activation impossible sans invitation consommée';
            END IF;
        ELSIF v_actor IS NOT NULL THEN
            PERFORM backoffice.assert_actor_permission('admins:manage');
            IF v_actor = NEW.id THEN
                RAISE EXCEPTION USING ERRCODE = 'BO002',
                    MESSAGE = 'backoffice.admin_users : un membre ne modifie pas son propre statut';
            END IF;
            -- La levée d'une suspension rend des droits : double validation.
            IF OLD.status = 'suspended' AND NEW.status = 'active' THEN
                PERFORM backoffice.assert_approved('admins:manage', 'admin_user', NEW.id::text);
            END IF;
        ELSIF NEW.status NOT IN ('suspended', 'disabled') THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002',
                MESSAGE = 'backoffice.admin_users : seul le personnel habilité rétablit un compte';
        END IF;
    END IF;
    IF NEW.allowed_ip_ranges IS DISTINCT FROM OLD.allowed_ip_ranges AND v_actor IS NOT NULL THEN
        PERFORM backoffice.assert_approved('admins:manage', 'admin_user', NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_users_operations_guard
    BEFORE UPDATE ON backoffice.admin_users
    FOR EACH ROW EXECUTE FUNCTION backoffice.admin_users_operations_guard();

-- Retrait d'un rôle : protecteur, une seule personne habilitée suffit, mais
-- elle doit être identifiée et ne peut pas se retirer un rôle à elle-même
-- (perte de contrôle du dernier administrateur).
CREATE FUNCTION backoffice.admin_user_roles_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor uuid := backoffice.current_admin_id();
BEGIN
    IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'backoffice.admin_user_roles : retrait définitif';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND v_actor IS NOT NULL THEN
        PERFORM backoffice.assert_actor_permission('admins:manage');
        IF NEW.revoked_by_admin_id IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002',
                MESSAGE = 'backoffice.admin_user_roles : le retrait doit identifier son auteur';
        END IF;
        IF NEW.admin_user_id = v_actor THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002',
                MESSAGE = 'backoffice.admin_user_roles : un membre ne se retire pas ses propres rôles';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_user_roles_guard
    BEFORE UPDATE ON backoffice.admin_user_roles
    FOR EACH ROW EXECUTE FUNCTION backoffice.admin_user_roles_guard();

-- Création d'un compte invité, exécutée par l'approbateur d'une demande
-- admins:manage portant sur cette adresse e-mail.
CREATE FUNCTION backoffice.create_invited_admin(
    p_email             text,
    p_full_name         text,
    p_allowed_ip_ranges cidr[],
    p_roles             text[],
    p_token_sha256      bytea,
    p_expires_at        timestamptz
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_approver  uuid;
    v_admin     uuid;
    v_role      text;
BEGIN
    v_approver := backoffice.current_admin_id();
    PERFORM backoffice.assert_approved('admins:manage', 'admin_invitation', p_email);
    IF p_roles IS NULL OR cardinality(p_roles) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'backoffice : un membre du personnel reçoit au moins un rôle';
    END IF;
    IF p_allowed_ip_ranges IS NULL OR cardinality(p_allowed_ip_ranges) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'backoffice : au moins une plage d''adresses autorisée est requise';
    END IF;

    INSERT INTO backoffice.admin_users (email, full_name, status, allowed_ip_ranges, invited_by_admin_id)
    VALUES (p_email, p_full_name, 'invited', p_allowed_ip_ranges, v_approver)
    RETURNING id INTO v_admin;

    FOREACH v_role IN ARRAY p_roles LOOP
        INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id)
        VALUES (v_admin, v_role, v_approver);
    END LOOP;

    INSERT INTO backoffice.invitations (admin_user_id, token_sha256, created_by_admin_id, expires_at)
    VALUES (v_admin, p_token_sha256, v_approver, p_expires_at);
    RETURN v_admin;
END;
$$;

-- Nouvelle invitation pour un compte invité dont l'invitation a expiré.
CREATE FUNCTION backoffice.renew_invitation(p_admin_user_id uuid, p_token_sha256 bytea, p_expires_at timestamptz)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_actor uuid := backoffice.assert_actor_permission('admins:manage');
    v_id    uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM backoffice.admin_users u WHERE u.id = p_admin_user_id AND u.status = 'invited') THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'backoffice : seul un compte encore invité reçoit une nouvelle invitation';
    END IF;
    UPDATE backoffice.invitations SET revoked_at = now()
     WHERE admin_user_id = p_admin_user_id AND consumed_at IS NULL AND revoked_at IS NULL;
    INSERT INTO backoffice.invitations (admin_user_id, token_sha256, created_by_admin_id, expires_at)
    VALUES (p_admin_user_id, p_token_sha256, v_actor, p_expires_at)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Attribution d'un rôle, exécutée par l'approbateur d'une demande
-- admins:manage portant sur ce membre.
CREATE FUNCTION backoffice.grant_role(p_admin_user_id uuid, p_role text)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_approver uuid := backoffice.current_admin_id();
BEGIN
    PERFORM backoffice.assert_approved('admins:manage', 'admin_user', p_admin_user_id::text);
    IF v_approver = p_admin_user_id THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'backoffice : un membre ne s''attribue pas de rôle';
    END IF;
    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id)
    VALUES (p_admin_user_id, p_role, v_approver)
    ON CONFLICT (admin_user_id, role_code) WHERE revoked_at IS NULL DO NOTHING;
END;
$$;

-- Premier super-administrateur, à l'installation. Réservée au propriétaire
-- du schéma (outil d'exploitation), refusée dès qu'un compte existe.
CREATE FUNCTION backoffice.bootstrap_super_admin(
    p_email             text,
    p_full_name         text,
    p_allowed_ip_ranges cidr[],
    p_token_sha256      bytea,
    p_expires_at        timestamptz
)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid;
BEGIN
    LOCK TABLE backoffice.admin_users IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM backoffice.admin_users u WHERE u.status IN ('invited', 'active', 'suspended')) THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'backoffice : le personnel existe déjà, utiliser une invitation';
    END IF;
    IF p_allowed_ip_ranges IS NULL OR cardinality(p_allowed_ip_ranges) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'backoffice : au moins une plage d''adresses autorisée est requise';
    END IF;
    INSERT INTO backoffice.admin_users (email, full_name, status, allowed_ip_ranges)
    VALUES (p_email, p_full_name, 'invited', p_allowed_ip_ranges)
    RETURNING id INTO v_admin;
    INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code, granted_by_admin_id)
    VALUES (v_admin, 'super_admin', NULL);
    INSERT INTO backoffice.invitations (admin_user_id, token_sha256, created_by_admin_id, expires_at)
    VALUES (v_admin, p_token_sha256, NULL, p_expires_at);
    PERFORM audit.record('system', 'bootstrap', 'backoffice.super_admin_bootstrapped', 'admin_user', v_admin::text,
                         NULL, NULL, NULL, jsonb_build_object('email', p_email));
    RETURN v_admin;
END;
$$;

-- -----------------------------------------------------------------------------
-- Décisions humaines vérifiées en base.
-- -----------------------------------------------------------------------------

-- Alertes AML : seule une personne habilitée les clôt, en son propre nom.
CREATE OR REPLACE FUNCTION aml.alerts_human_resolution()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid;
BEGIN
    IF NEW.status IN ('closed_false_positive', 'closed_confirmed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        IF backoffice.current_admin_id() IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'aml.alerts : seule une décision humaine clôt une alerte';
        END IF;
        v_admin := backoffice.assert_actor_permission('aml:alerts:manage');
        IF NEW.resolved_by_admin_id IS DISTINCT FROM v_admin THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'aml.alerts : la clôture doit être signée par son auteur';
        END IF;
    ELSIF backoffice.current_admin_id() IS NOT NULL AND (
           NEW.status IS DISTINCT FROM OLD.status OR NEW.assigned_to_admin_id IS DISTINCT FROM OLD.assigned_to_admin_id
    ) THEN
        PERFORM backoffice.assert_actor_permission('aml:alerts:manage');
    END IF;
    RETURN NEW;
END;
$$;

-- Dossiers d'enquête : ouverts et instruits par le personnel habilité ; la
-- déclaration de soupçon exige une double validation.
CREATE FUNCTION aml.cases_operations_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid := backoffice.assert_actor_permission('aml:cases:manage');
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' OR NEW.opened_by_admin_id IS DISTINCT FROM v_admin THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'aml.cases : un dossier naît ouvert, au nom de son auteur';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'closed' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'aml.cases : un dossier clos est définitif';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'open'          AND NEW.status IN ('investigating', 'closed'))
            OR (OLD.status = 'investigating' AND NEW.status IN ('sar_filed', 'closed'))
            OR (OLD.status = 'sar_filed'     AND NEW.status = 'closed')
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'TR001',
                MESSAGE = format('aml.cases : transition %s → %s interdite', OLD.status, NEW.status);
        END IF;
        IF NEW.status = 'sar_filed' THEN
            PERFORM backoffice.assert_approved('aml:sar:file', 'aml_case', NEW.id::text);
        END IF;
        IF NEW.status = 'closed' THEN
            NEW.closed_at := now();
        END IF;
    END IF;
    IF NEW.sar_reference IS DISTINCT FROM OLD.sar_reference AND NEW.status <> 'sar_filed' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'aml.cases : référence de déclaration hors déclaration';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cases_operations_guard
    BEFORE INSERT OR UPDATE ON aml.cases
    FOR EACH ROW EXECUTE FUNCTION aml.cases_operations_guard();

CREATE FUNCTION aml.case_alerts_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM backoffice.assert_actor_permission('aml:cases:manage');
    IF NOT EXISTS (
        SELECT 1 FROM aml.cases c JOIN aml.alerts a ON a.user_id = c.user_id
         WHERE c.id = NEW.case_id AND a.id = NEW.alert_id AND c.status IN ('open', 'investigating')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007',
            MESSAGE = 'aml.case_alerts : l''alerte doit concerner le client du dossier, encore ouvert';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER case_alerts_guard
    BEFORE INSERT ON aml.case_alerts
    FOR EACH ROW EXECUTE FUNCTION aml.case_alerts_guard();

-- KYC : une décision manuelle est prise par une personne habilitée, en son nom.
CREATE FUNCTION kyc.verifications_admin_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid;
BEGIN
    IF backoffice.current_admin_id() IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
        v_admin := backoffice.assert_actor_permission('kyc:decide');
        IF NEW.decided_by_admin_id IS DISTINCT FROM v_admin THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002',
                MESSAGE = 'kyc.verifications : la décision doit être signée par son auteur';
        END IF;
    END IF;
    IF NEW.decided_by_admin_id IS DISTINCT FROM OLD.decided_by_admin_id AND backoffice.current_admin_id() IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002',
            MESSAGE = 'kyc.verifications : décideur humain renseigné hors décision humaine';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER verifications_admin_guard
    BEFORE UPDATE ON kyc.verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.verifications_admin_guard();

-- Statut d'un client modifié par le personnel : customers:suspend.
CREATE FUNCTION identity.users_backoffice_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND backoffice.current_admin_id() IS NOT NULL THEN
        PERFORM backoffice.assert_actor_permission('customers:suspend');
        IF NOT ((OLD.status = 'active' AND NEW.status = 'suspended') OR (OLD.status = 'suspended' AND NEW.status = 'active')) THEN
            RAISE EXCEPTION USING ERRCODE = 'TR001',
                MESSAGE = format('identity.users : transition %s → %s interdite au personnel', OLD.status, NEW.status);
        END IF;
        NEW.suspended_at := CASE WHEN NEW.status = 'suspended' THEN now() ELSE NULL END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_backoffice_guard
    BEFORE UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION identity.users_backoffice_guard();

-- Registre : ajustements et contre-passations ordonnés par le personnel.
CREATE FUNCTION ledger.journals_backoffice_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF backoffice.current_admin_id() IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.journal_type = 'adjustment' THEN
        PERFORM backoffice.assert_approved('ledger:adjust', 'ledger_adjustment', NEW.idempotency_key);
    ELSIF NEW.journal_type = 'reversal' THEN
        PERFORM backoffice.assert_approved('ledger:adjust', 'ledger_journal', NEW.reverses_journal_id::text);
    ELSE
        RAISE EXCEPTION USING ERRCODE = 'BO002',
            MESSAGE = format('ledger.journals : le personnel ne passe pas de journal %s', NEW.journal_type);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER journals_backoffice_guard
    BEFORE INSERT ON ledger.journals
    FOR EACH ROW EXECUTE FUNCTION ledger.journals_backoffice_guard();

CREATE FUNCTION ledger.accounts_backoffice_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND backoffice.current_admin_id() IS NOT NULL THEN
        PERFORM backoffice.assert_approved('ledger:freeze', 'ledger_account', NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_backoffice_guard
    BEFORE UPDATE OF status ON ledger.accounts
    FOR EACH ROW EXECUTE FUNCTION ledger.accounts_backoffice_guard();

-- -----------------------------------------------------------------------------
-- Transferts : mise en revue manuelle, libération et remboursement ordonnés.
-- -----------------------------------------------------------------------------
ALTER TABLE aml.rules ADD COLUMN is_manual boolean NOT NULL DEFAULT false;

INSERT INTO aml.rules (code, description, severity, blocks_transfer, parameters, is_manual) VALUES
    ('MANUAL_REVIEW',
     'Mise en revue décidée par la conformité',
     'high', true, '{}', true)
ON CONFLICT (code) DO NOTHING;

-- Les alertes MANUAL_REVIEW ne naissent que d'une décision humaine habilitée.
CREATE FUNCTION aml.alerts_manual_origin()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM aml.rules r WHERE r.code = NEW.rule_code AND r.is_manual) THEN
        PERFORM backoffice.assert_actor_permission('transfers:hold');
        IF NEW.assigned_to_admin_id IS DISTINCT FROM backoffice.current_admin_id() THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'aml.alerts : une mise en revue manuelle est attribuée à son auteur';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_manual_origin
    BEFORE INSERT ON aml.alerts
    FOR EACH ROW EXECUTE FUNCTION aml.alerts_manual_origin();

-- Garde v5 : la mise en revue est justifiée par une évaluation « review » OU
-- par une alerte manuelle encore ouverte.
DO $$
DECLARE
    v_definition text := pg_get_functiondef('transfers.transfers_guard()'::regprocedure);
    v_search     text := $s$SELECT 1 FROM aml.transfer_evaluations e WHERE e.transfer_id = NEW.id AND e.outcome = 'review'
                ) THEN$s$;
    v_replace    text := $r$SELECT 1 FROM aml.transfer_evaluations e WHERE e.transfer_id = NEW.id AND e.outcome = 'review'
                ) AND NOT EXISTS (
                    SELECT 1 FROM aml.alerts a JOIN aml.rules r ON r.code = a.rule_code
                     WHERE a.transfer_id = NEW.id AND r.is_manual AND a.status IN ('open', 'under_review', 'escalated')
                ) THEN$r$;
BEGIN
    IF strpos(v_definition, v_search) = 0 THEN
        RAISE EXCEPTION 'transfers_guard : fragment attendu introuvable, migration à revoir';
    END IF;
    EXECUTE replace(v_definition, v_search, v_replace);
END;
$$;

CREATE FUNCTION transfers.transfers_backoffice_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_admin uuid := backoffice.current_admin_id();
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    -- Sortie de revue : toujours une décision humaine habilitée.
    IF OLD.status = 'compliance_review' AND NEW.status = 'payout_pending' THEN
        IF v_admin IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'transfers : seule une décision humaine libère un transfert en revue';
        END IF;
        PERFORM backoffice.assert_actor_permission('transfers:release');
    END IF;
    IF v_admin IS NOT NULL THEN
        CASE NEW.status
            WHEN 'compliance_review' THEN
                PERFORM backoffice.assert_actor_permission('transfers:hold');
            WHEN 'refund_pending' THEN
                PERFORM backoffice.assert_approved('transfers:refund', 'transfer', NEW.id::text);
            WHEN 'payout_pending' THEN
                NULL;
            ELSE
                RAISE EXCEPTION USING ERRCODE = 'BO002',
                    MESSAGE = format('transfers : le personnel ne fait pas passer un transfert en %s', NEW.status);
        END CASE;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transfers_backoffice_guard
    BEFORE UPDATE ON transfers.transfers
    FOR EACH ROW EXECUTE FUNCTION transfers.transfers_backoffice_guard();

-- -----------------------------------------------------------------------------
-- Droits.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON backoffice.invitations, backoffice.webauthn_challenges, backoffice.refresh_tokens TO app_api;
GRANT SELECT ON backoffice.invitations, backoffice.webauthn_challenges TO app_auditor;

-- Création de comptes et attribution de rôles : uniquement par les fonctions
-- à double validation.
REVOKE INSERT ON backoffice.admin_users, backoffice.admin_user_roles FROM app_api;

GRANT EXECUTE ON FUNCTION backoffice.current_admin_id(),
                          backoffice.assert_actor_permission(text),
                          backoffice.assert_approved(text, text, text),
                          backoffice.create_invited_admin(text, text, cidr[], text[], bytea, timestamptz),
                          backoffice.renew_invitation(uuid, bytea, timestamptz),
                          backoffice.grant_role(uuid, text)
    TO app_api;
-- Vérification de la chaîne d'audit depuis le back-office (audit:read).
GRANT EXECUTE ON FUNCTION audit.verify_chain() TO app_api;
REVOKE EXECUTE ON FUNCTION backoffice.bootstrap_super_admin(text, text, cidr[], bytea, timestamptz) FROM PUBLIC, app_api;

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['invitations', 'webauthn_challenges', 'refresh_tokens'] LOOP
        EXECUTE format('ALTER TABLE backoffice.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('CREATE POLICY app_api_all ON backoffice.%I FOR ALL TO app_api USING (true) WITH CHECK (true)', v_table);
        EXECUTE format('CREATE POLICY app_auditor_select ON backoffice.%I FOR SELECT TO app_auditor USING (true)', v_table);
    END LOOP;
END;
$$;
