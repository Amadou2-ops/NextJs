-- =============================================================================
-- 0001 — Schémas et fonctions utilitaires
--
-- Chaque domaine métier vit dans son propre schéma afin de pouvoir accorder
-- des privilèges au plus juste (voir 0016). Aucun objet métier n'est créé dans
-- le schéma "public" : sur Supabase, "public" est exposé par PostgREST, nos
-- schémas ne le sont pas.
--
-- Registre des codes d'erreur SQLSTATE applicatifs (mappés par l'API) :
--   LG001  fonds insuffisants sur un compte qui ne peut pas être négatif
--   LG002  écriture déséquilibrée (débits ≠ crédits pour une devise)
--   LG003  compte non mouvementable (gelé ou clôturé)
--   LG004  devise de l'écriture ≠ devise du compte
--   LG005  clé d'idempotence déjà utilisée avec un contenu différent
--   LG006  tentative de modification/suppression d'un enregistrement immuable
--   LG007  données d'écriture invalides
--   LG008  contre-passation invalide
--   LG009  chaîne d'empreintes du registre rompue
--   TR001  transition de statut de transfert interdite
--   TR002  devis de change expiré ou déjà consommé
--   PY001  transition de statut de tentative de paiement interdite
--   BO001  règle des quatre yeux violée (demandeur = approbateur)
-- =============================================================================

CREATE SCHEMA util;
CREATE SCHEMA ref;
CREATE SCHEMA identity;
CREATE SCHEMA kyc;
CREATE SCHEMA fx;
CREATE SCHEMA ledger;
CREATE SCHEMA transfers;
CREATE SCHEMA payments;
CREATE SCHEMA integrations;
CREATE SCHEMA aml;
CREATE SCHEMA backoffice;
CREATE SCHEMA audit;

COMMENT ON SCHEMA util IS 'Fonctions techniques partagées (triggers génériques).';
COMMENT ON SCHEMA ref IS 'Données de référence : pays (ISO 3166-1), devises (ISO 4217).';
COMMENT ON SCHEMA identity IS 'Clients, appareils, sessions, jetons de renouvellement, OTP.';
COMMENT ON SCHEMA kyc IS 'Vérifications d''identité (Smile ID, Onfido) et documents.';
COMMENT ON SCHEMA fx IS 'Taux de change (Fixer, Open Exchange Rates) et devis.';
COMMENT ON SCHEMA ledger IS 'Registre comptable en partie double, immuable et chaîné.';
COMMENT ON SCHEMA transfers IS 'Bénéficiaires, transferts, machine à états, frais.';
COMMENT ON SCHEMA payments IS 'Passerelles, corridors, moteur de routage, tentatives.';
COMMENT ON SCHEMA integrations IS 'Webhooks entrants, outbox, idempotence HTTP.';
COMMENT ON SCHEMA aml IS 'Lutte anti-blanchiment : règles, alertes, dossiers, criblage.';
COMMENT ON SCHEMA backoffice IS 'Personnel interne, RBAC, double validation.';
COMMENT ON SCHEMA audit IS 'Journal d''audit chaîné, en ajout seul.';

-- Aucun rôle ne doit pouvoir créer d'objets dans public (défense contre le
-- détournement du search_path). Par défaut depuis PostgreSQL 15, réaffirmé ici.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Horodatage automatique de updated_at.
-- -----------------------------------------------------------------------------
CREATE FUNCTION util.set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Interdiction générique de UPDATE / DELETE sur une table en ajout seul.
-- -----------------------------------------------------------------------------
CREATE FUNCTION util.forbid_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = 'LG006',
        MESSAGE = format('%I.%I est immuable : %s interdit', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP),
        HINT = 'Les corrections passent par un nouvel enregistrement (contre-passation, événement correctif).';
END;
$$;

-- -----------------------------------------------------------------------------
-- Interdiction de TRUNCATE (déclencheur au niveau instruction).
-- -----------------------------------------------------------------------------
CREATE FUNCTION util.forbid_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = 'LG006',
        MESSAGE = format('%I.%I est immuable : TRUNCATE interdit', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

-- -----------------------------------------------------------------------------
-- Interdit la modification de colonnes figées après insertion. Les colonnes
-- autorisées à évoluer sont passées en arguments du trigger.
-- Exemple : EXECUTE FUNCTION util.restrict_update('status', 'updated_at')
-- -----------------------------------------------------------------------------
CREATE FUNCTION util.restrict_update()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_old     jsonb := to_jsonb(OLD);
    v_new     jsonb := to_jsonb(NEW);
    v_allowed text[] := TG_ARGV;
    v_key     text;
BEGIN
    FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
        IF NOT (v_key = ANY (v_allowed))
           AND (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
            RAISE EXCEPTION USING
                ERRCODE = 'LG006',
                MESSAGE = format('%I.%I : la colonne %I est figée après insertion',
                                 TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key);
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
