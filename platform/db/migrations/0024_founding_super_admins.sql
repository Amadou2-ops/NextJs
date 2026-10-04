-- =============================================================================
-- 0024 — Amorçage par un binôme fondateur de super-administrateurs
-- =============================================================================
-- Toute attribution de droits (invitation, rôle, réseau, réactivation) exige
-- la double validation : un demandeur et un approbateur distincts, tous deux
-- habilités. Avec un seul super-administrateur amorcé (0023), aucune
-- invitation ne pouvait jamais être approuvée : l'installation était bloquée.
--
-- L'amorçage (connexion propriétaire du schéma, hors API) crée désormais au
-- plus DEUX super-administrateurs fondateurs, chacun avec sa propre
-- invitation, puis se ferme définitivement :
--   - refusé dès que deux comptes du personnel ont existé (quel que soit leur
--     état : un compte désactivé ne rouvre pas l'amorçage) ;
--   - refusé dès qu'un compte a été créé par invitation d'un membre (le
--     back-office est alors en service).
-- =============================================================================

CREATE OR REPLACE FUNCTION backoffice.bootstrap_super_admin(
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
    IF (SELECT count(*) FROM backoffice.admin_users) >= 2
       OR EXISTS (SELECT 1 FROM backoffice.invitations i WHERE i.created_by_admin_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'BO002', MESSAGE = 'backoffice : les fondateurs existent déjà, utiliser une invitation';
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

-- Mêmes privilèges qu'en 0023 : réservé au propriétaire du schéma.
REVOKE EXECUTE ON FUNCTION backoffice.bootstrap_super_admin(text, text, cidr[], bytea, timestamptz) FROM PUBLIC, app_api;
