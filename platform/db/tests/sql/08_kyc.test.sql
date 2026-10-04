-- =============================================================================
-- KYC (0020) : niveau accordé par la base uniquement, approbation automatique
-- conditionnée à une preuve concordante, doublons de pièce, identité figée,
-- vérification unique en cours, routage.
-- =============================================================================
DO $$
DECLARE
    v_carol         uuid;
    v_dave          uuid;
    v_verification  uuid;
    v_second        uuid;
    v_dave_check    uuid;
    v_bidx          bytea := sha256('FR:12AB34567');
BEGIN
    INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                pii_key_id, status, phone_verified_at)
    VALUES (sha256('fixture-carol'), '\x03', 'FR', '$argon2id$v=19$m=65536,t=3,p=4$fixture', 'FR',
            'kms-key-v1', 'active', now())
    RETURNING id INTO v_carol;
    INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                pii_key_id, status, phone_verified_at)
    VALUES (sha256('fixture-dave'), '\x04', 'FR', '$argon2id$v=19$m=65536,t=3,p=4$fixture', 'FR',
            'kms-key-v1', 'active', now())
    RETURNING id INTO v_dave;

    -- Les niveaux des fixtures ont été accordés par des approbations.
    PERFORM pg_temp.assert_true(
        (SELECT kyc_tier FROM identity.users WHERE id = pg_temp.id('alice')) = 'tier_2', 'niveau 2 accordé à Alice');
    PERFORM pg_temp.assert_true(
        (SELECT kyc_tier FROM identity.users WHERE id = pg_temp.id('bob')) = 'tier_1', 'niveau 1 accordé à Bob');

    -- Un compte naît au niveau 0.
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO identity.users (phone_bidx, phone_enc, phone_country, password_hash, country_of_residence,
                                       pii_key_id, kyc_tier)
           VALUES (sha256('forged'), '\x05', 'FR', '$argon2id$v=19$m=65536,t=3,p=4$x', 'FR', 'kms-key-v1', 'tier_3')$q$,
        'LG007', 'compte créé à un niveau KYC élevé refusé');

    -- Hausse de niveau sans vérification approuvée : refusée.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE identity.users SET kyc_tier = 'tier_1' WHERE id = %L$q$, v_carol),
        'LG007', 'niveau forgé refusé');
    PERFORM pg_temp.assert_error(
        format($q$UPDATE identity.users SET kyc_tier = 'tier_3' WHERE id = %L$q$, pg_temp.id('alice')),
        'LG007', 'niveau supérieur à celui justifié refusé');

    -- Vérification de Carol.
    PERFORM set_config('app.actor_type', 'provider', true);
    PERFORM set_config('app.actor_id', 'onfido', true);
    UPDATE identity.users SET first_name_enc = '\x10', last_name_enc = '\x11', date_of_birth_enc = '\x12' WHERE id = v_carol;
    INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference)
    VALUES (v_carol, 'onfido', 'document_verification', 'tier_1', 'run-carol-1')
    RETURNING id INTO v_verification;

    -- Une seule vérification en cours.
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested)
                  VALUES (%L, 'onfido', 'proof_of_address', 'tier_2')$q$, v_carol),
        '23505', 'seconde vérification simultanée refusée');

    -- Identité déclarée figée pendant la vérification.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE identity.users SET last_name_enc = '\x99' WHERE id = %L$q$, v_carol),
        'LG006', 'identité déclarée figée pendant la vérification');

    UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = v_verification;

    -- Approbation automatique sans preuve : refusée.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.verifications SET status = 'approved', decided_at = now(),
                         expires_at = now() + interval '2 years' WHERE id = %L$q$, v_verification),
        'LG007', 'approbation sans preuve refusée');

    -- Preuve d'un autre client : refusée.
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, pii_key_id, declared_identity_match)
                  VALUES (%L, %L, 'onfido', 'kms-key-v1', true)$q$, v_verification, v_dave),
        'LG007', 'preuve rattachée à un autre client refusée');

    -- Preuve non concordante : approbation automatique refusée.
    INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, document_type, issuing_country,
                                       document_number_enc, document_number_bidx, pii_key_id, declared_identity_match)
    VALUES (v_verification, v_carol, 'onfido', 'passport', 'FR', '\x20', v_bidx, 'kms-key-v1', false);
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.verifications SET status = 'approved', decided_at = now(),
                         expires_at = now() + interval '2 years' WHERE id = %L$q$, v_verification),
        'LG007', 'approbation avec identité discordante refusée');
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.identity_evidence SET declared_identity_match = true WHERE verification_id = %L$q$, v_verification),
        'LG006', 'preuve immuable');

    -- Revue manuelle puis rejet : niveau inchangé, identité modifiable de nouveau.
    UPDATE kyc.verifications SET status = 'rejected', decided_at = now() WHERE id = v_verification;
    PERFORM pg_temp.assert_true(
        (SELECT kyc_tier FROM identity.users WHERE id = v_carol) = 'tier_0', 'rejet sans effet sur le niveau');
    UPDATE identity.users SET last_name_enc = '\x13' WHERE id = v_carol;

    -- Seconde tentative concordante : approbation sans date d'expiration refusée, puis accordée.
    INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference)
    VALUES (v_carol, 'onfido', 'document_verification', 'tier_1', 'run-carol-2')
    RETURNING id INTO v_second;
    UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = v_second;
    INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, document_type, issuing_country,
                                       document_number_enc, document_number_bidx, pii_key_id, declared_identity_match)
    VALUES (v_second, v_carol, 'onfido', 'passport', 'FR', '\x21', v_bidx, 'kms-key-v1', true);
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.verifications SET status = 'approved', decided_at = now() WHERE id = %L$q$, v_second),
        'LG007', 'approbation sans expiration refusée');
    UPDATE kyc.verifications
       SET status = 'approved', decided_at = now(), expires_at = now() + interval '2 years'
     WHERE id = v_second;
    PERFORM pg_temp.assert_true(
        (SELECT kyc_tier FROM identity.users WHERE id = v_carol) = 'tier_1', 'niveau 1 accordé par la base');

    -- Identité figée après octroi d'un niveau.
    PERFORM pg_temp.assert_error(
        format($q$UPDATE identity.users SET first_name_enc = '\x98' WHERE id = %L$q$, v_carol),
        'LG006', 'identité déclarée figée après octroi');

    -- Même passeport présenté par Dave : approbation automatique impossible.
    INSERT INTO kyc.verifications (user_id, provider, job_type, tier_requested, provider_reference)
    VALUES (v_dave, 'onfido', 'document_verification', 'tier_1', 'run-dave-1')
    RETURNING id INTO v_dave_check;
    UPDATE kyc.verifications SET status = 'submitted', submitted_at = now() WHERE id = v_dave_check;
    INSERT INTO kyc.identity_evidence (verification_id, user_id, provider, document_type, issuing_country,
                                       document_number_enc, document_number_bidx, pii_key_id, declared_identity_match)
    VALUES (v_dave_check, v_dave, 'onfido', 'passport', 'FR', '\x22', v_bidx, 'kms-key-v1', true);
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.verifications SET status = 'approved', decided_at = now(),
                         expires_at = now() + interval '2 years' WHERE id = %L$q$, v_dave_check),
        'LG007', 'pièce en double : approbation automatique refusée');
    UPDATE kyc.verifications SET status = 'in_review' WHERE id = v_dave_check;

    -- Expiration : le niveau est recalculé.
    UPDATE kyc.verifications SET status = 'expired' WHERE id = v_second;
    PERFORM pg_temp.assert_true(
        (SELECT kyc_tier FROM identity.users WHERE id = v_carol) = 'tier_0', 'niveau retiré à l''expiration');

    -- Routage : combinaisons non prises en charge refusées, seed chargé.
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO kyc.provider_routes (country_of_residence, tier, provider, job_type)
           VALUES ('FR', 'tier_2', 'smile_id', 'proof_of_address')$q$,
        '23514', 'Smile ID sans preuve de domicile');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO kyc.provider_routes (country_of_residence, tier, provider, job_type)
           VALUES (NULL, 'tier_1', 'onfido', 'document_verification')$q$,
        '23505', 'règle par défaut unique');
    PERFORM pg_temp.assert_true(
        (SELECT provider FROM kyc.provider_routes
          WHERE tier = 'tier_1' AND (country_of_residence = 'NG' OR country_of_residence IS NULL) AND is_enabled
          ORDER BY country_of_residence IS NULL, priority LIMIT 1) = 'smile_id',
        'résident nigérian routé vers Smile ID');

    -- Dossier prestataire immuable et unique.
    INSERT INTO kyc.provider_applicants (user_id, provider, applicant_reference) VALUES (v_carol, 'onfido', 'applicant-carol');
    PERFORM pg_temp.assert_error(
        format($q$INSERT INTO kyc.provider_applicants (user_id, provider, applicant_reference)
                  VALUES (%L, 'onfido', 'applicant-carol')$q$, v_dave),
        '23505', 'dossier prestataire partagé refusé');
    PERFORM pg_temp.assert_error(
        format($q$UPDATE kyc.provider_applicants SET applicant_reference = 'x' WHERE user_id = %L$q$, v_carol),
        'LG006', 'dossier prestataire immuable');
END;
$$;
