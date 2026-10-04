-- =============================================================================
-- Amorçage (0024) : un binôme fondateur de super-administrateurs, sans quoi
-- la double validation ne pourrait jamais accorder le premier droit ; puis
-- l'amorçage est définitivement fermé.
-- =============================================================================
DO $$
DECLARE
    v_first   uuid;
    v_second  uuid;
BEGIN
    -- Scénario annulé à la fin du bloc : un seul fondateur, mais le
    -- back-office déjà en service (invitation émise par un membre).
    BEGIN
        v_first := backoffice.bootstrap_super_admin('seul@transfertplus.example', 'Seul', ARRAY['10.0.0.0/8']::cidr[],
                                                    sha256('jeton-seul'::bytea), now() + interval '24 hours');
        -- Invitation renouvelée par un membre (une seule invitation ouverte par compte).
        UPDATE backoffice.invitations SET revoked_at = now() WHERE admin_user_id = v_first;
        INSERT INTO backoffice.invitations (admin_user_id, token_sha256, created_by_admin_id, expires_at)
        VALUES (v_first, sha256('jeton-renouvele'::bytea), v_first, now() + interval '24 hours');
        PERFORM pg_temp.assert_error(
            $q$SELECT backoffice.bootstrap_super_admin('tard@transfertplus.example', 'Tard', ARRAY['10.0.0.0/8']::cidr[],
                   sha256('jeton-tard'::bytea), now() + interval '24 hours')$q$,
            'BO002', 'amorçage fermé dès qu''un membre a émis une invitation');
        RAISE EXCEPTION USING ERRCODE = 'ZZ999', MESSAGE = 'annulation du scénario';
    EXCEPTION WHEN SQLSTATE 'ZZ999' THEN
        NULL;
    END;
    IF EXISTS (SELECT 1 FROM backoffice.admin_users) THEN
        RAISE EXCEPTION 'le scénario précédent aurait dû être annulé';
    END IF;

    -- Binôme fondateur.
    v_first := backoffice.bootstrap_super_admin('fondateur.a@transfertplus.example', 'Fondateur A', ARRAY['10.0.0.0/8']::cidr[],
                                                sha256('jeton-a'::bytea), now() + interval '24 hours');
    v_second := backoffice.bootstrap_super_admin('fondateur.b@transfertplus.example', 'Fondateur B', ARRAY['10.0.0.0/8']::cidr[],
                                                 sha256('jeton-b'::bytea), now() + interval '24 hours');
    IF v_first = v_second THEN
        RAISE EXCEPTION 'deux fondateurs distincts attendus';
    END IF;
    IF (SELECT count(*) FROM backoffice.admin_user_roles WHERE role_code = 'super_admin' AND admin_user_id IN (v_first, v_second) AND revoked_at IS NULL) <> 2 THEN
        RAISE EXCEPTION 'chaque fondateur est super-administrateur';
    END IF;
    IF (SELECT count(*) FROM backoffice.invitations WHERE admin_user_id IN (v_first, v_second) AND created_by_admin_id IS NULL) <> 2 THEN
        RAISE EXCEPTION 'chaque fondateur reçoit sa propre invitation';
    END IF;

    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.bootstrap_super_admin('troisieme@transfertplus.example', 'Troisième', ARRAY['10.0.0.0/8']::cidr[],
               sha256('jeton-c'::bytea), now() + interval '24 hours')$q$,
        'BO002', 'pas de troisième fondateur');

    -- Un fondateur désactivé ne rouvre pas l'amorçage.
    UPDATE backoffice.invitations SET revoked_at = now() WHERE admin_user_id = v_second;
    UPDATE backoffice.admin_users SET status = 'disabled', disabled_at = now() WHERE id = v_second;
    PERFORM pg_temp.assert_error(
        $q$SELECT backoffice.bootstrap_super_admin('remplacant@transfertplus.example', 'Remplaçant', ARRAY['10.0.0.0/8']::cidr[],
               sha256('jeton-d'::bytea), now() + interval '24 hours')$q$,
        'BO002', 'amorçage fermé même après désactivation d''un fondateur');
END;
$$;
