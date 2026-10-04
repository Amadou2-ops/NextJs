-- =============================================================================
-- 0029 — Clôture du compte à l'initiative du client.
--
-- Exigée par les magasins d'applications (suppression du compte depuis
-- l'application) ; les données restent conservées pour la durée légale
-- (LCB-FT, 5 ans minimum) : la clôture ferme l'accès, ne supprime rien.
--
-- identity.close_customer_account :
--   - compte actif seulement (suspendu : décision du service client) ;
--   - tous les comptes du registre du client à solde nul (aucun argent du
--     client ne reste sans titulaire) — ID001 ;
--   - aucun transfert en cours (financement, revue, paiement, remboursement)
--     — ID002 ;
--   - comptes du registre clôturés, sessions, jetons, appareils et passkeys
--     révoqués, statut « closed » ; la clôture est définitive.
--
-- Codes SQLSTATE ajoutés au registre (0001) :
--   ID001  clôture refusée : solde non nul
--   ID002  clôture refusée : transfert en cours
-- =============================================================================

CREATE FUNCTION identity.users_closure_final()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = 'identity.users : un compte clôturé ne peut pas être rouvert';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_closure_final
    BEFORE UPDATE OF status ON identity.users
    FOR EACH ROW EXECUTE FUNCTION identity.users_closure_final();

CREATE FUNCTION identity.close_customer_account(p_user_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_status    identity.user_status;
    v_account   record;
    v_sessions  integer;
BEGIN
    SELECT u.status INTO v_status FROM identity.users u WHERE u.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'LG007', MESSAGE = 'identity.close_customer_account : client inconnu';
    END IF;
    IF v_status <> 'active' THEN
        RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = format('identity.close_customer_account : compte %s', v_status);
    END IF;

    -- Comptes verrouillés : aucune écriture concurrente pendant la vérification.
    PERFORM 1 FROM ledger.accounts a WHERE a.owner_user_id = p_user_id ORDER BY a.id FOR UPDATE;
    IF EXISTS (SELECT 1
                 FROM ledger.accounts a
                 JOIN ledger.account_balances b ON b.account_id = a.id
                WHERE a.owner_user_id = p_user_id AND b.balance <> 0) THEN
        RAISE EXCEPTION USING ERRCODE = 'ID001', MESSAGE = 'identity.close_customer_account : solde non nul';
    END IF;
    IF EXISTS (SELECT 1 FROM transfers.transfers t
                WHERE t.user_id = p_user_id AND t.status NOT IN ('completed', 'cancelled', 'refunded')) THEN
        RAISE EXCEPTION USING ERRCODE = 'ID002', MESSAGE = 'identity.close_customer_account : transfert en cours';
    END IF;

    FOR v_account IN SELECT a.id FROM ledger.accounts a WHERE a.owner_user_id = p_user_id AND a.status <> 'closed' LOOP
        PERFORM ledger.set_account_status(v_account.id, 'closed', 'clôture du compte par le client');
    END LOOP;

    UPDATE identity.refresh_tokens r SET revoked_at = now(), revoked_reason = 'account_closed'
      FROM identity.sessions s
     WHERE r.session_id = s.id AND s.user_id = p_user_id AND r.revoked_at IS NULL;
    UPDATE identity.sessions SET revoked_at = now(), revoked_reason = 'account_closed'
     WHERE user_id = p_user_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
    UPDATE identity.devices SET revoked_at = now(), revoked_reason = 'account_closed'
     WHERE user_id = p_user_id AND revoked_at IS NULL;
    UPDATE identity.webauthn_credentials SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL;

    UPDATE identity.users SET status = 'closed', closed_at = now() WHERE id = p_user_id;
    RETURN v_sessions;
END;
$$;

REVOKE ALL ON FUNCTION identity.close_customer_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.close_customer_account(uuid) TO app_api;
