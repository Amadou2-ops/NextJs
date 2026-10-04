-- =============================================================================
-- Authentification (0017) : défis à usage unique, anti-rejeu TOTP, cohérence
-- des défis de connexion, privilèges.
-- =============================================================================
DO $$
DECLARE
    v_alice         uuid := pg_temp.id('alice');
    v_device_ch     uuid;
    v_otp           uuid;
    v_login         uuid;
    v_webauthn      uuid;
BEGIN
    -- Défi d'attestation : consommation unique, pas après expiration.
    INSERT INTO identity.device_challenges (challenge, expires_at)
    VALUES (sha256(convert_to(gen_random_uuid()::text, 'UTF8')), now() + interval '5 minutes')
    RETURNING id INTO v_device_ch;
    UPDATE identity.device_challenges SET consumed_at = now() WHERE id = v_device_ch;
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.device_challenges SET consumed_at = now() WHERE id = %L', v_device_ch),
        'LG006', 'défi d''attestation consommé deux fois');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO identity.device_challenges (challenge, expires_at) VALUES (sha256('x'), now() + interval '1 hour')$q$,
        '23514', 'défi d''attestation de plus de 10 minutes refusé');

    -- Anti-rejeu TOTP : le pas utilisé ne peut que croître.
    UPDATE identity.users SET mfa_totp_secret_enc = '\x01', mfa_totp_enabled_at = now(), mfa_totp_last_used_step = 1000 WHERE id = v_alice;
    UPDATE identity.users SET mfa_totp_last_used_step = 1001 WHERE id = v_alice;
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.users SET mfa_totp_last_used_step = 1001 WHERE id = %L', v_alice),
        'LG006', 'réutilisation d''un pas TOTP refusée');
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.users SET mfa_totp_last_used_step = 999 WHERE id = %L', v_alice),
        'LG006', 'retour arrière du pas TOTP refusé');
    -- Nouveau secret (réenrôlement) : le compteur repart.
    UPDATE identity.users SET mfa_totp_secret_enc = '\x02', mfa_totp_last_used_step = 5 WHERE id = v_alice;

    -- Défi de connexion : cohérence méthode / code SMS / appareil.
    INSERT INTO identity.otp_challenges (user_id, purpose, channel, destination_bidx, code_hmac, expires_at)
    VALUES (v_alice, 'login', 'sms', sha256('dest'), sha256('code'), now() + interval '5 minutes')
    RETURNING id INTO v_otp;
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO identity.login_challenges (user_id, audience, method, otp_challenge_id, expires_at)
           VALUES (%L, 'web', 'totp', %L, now() + interval '5 minutes')$q$, v_alice, v_otp),
        '23514', 'défi TOTP lié à un code SMS refusé');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO identity.login_challenges (user_id, audience, method, expires_at)
           VALUES (%L, 'mobile', 'totp', now() + interval '5 minutes')$q$, v_alice),
        '23514', 'défi mobile sans appareil refusé');
    PERFORM pg_temp.assert_error(format(
        $q$INSERT INTO identity.login_challenges (user_id, audience, method, pending_device, expires_at)
           VALUES (%L, 'web', 'totp', '{}'::jsonb, now() + interval '5 minutes')$q$, v_alice),
        '23514', 'défi web avec appareil refusé');

    INSERT INTO identity.login_challenges (user_id, audience, method, otp_challenge_id, expires_at)
    VALUES (v_alice, 'web', 'sms_otp', v_otp, now() + interval '5 minutes')
    RETURNING id INTO v_login;
    UPDATE identity.login_challenges SET attempts = 2 WHERE id = v_login;
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.login_challenges SET attempts = 1 WHERE id = %L', v_login),
        'LG006', 'compteur de tentatives non décroissant');
    UPDATE identity.login_challenges SET consumed_at = now() WHERE id = v_login;
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.login_challenges SET attempts = 3 WHERE id = %L', v_login),
        'LG006', 'défi de connexion consommé définitif');
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.login_challenges SET user_id = %L WHERE id = %L', pg_temp.id('bob'), v_login),
        'LG006', 'utilisateur du défi figé');

    -- Défi WebAuthn.
    INSERT INTO identity.webauthn_challenges (ceremony, challenge, expires_at)
    VALUES ('authentication', repeat('A', 43), now() + interval '5 minutes')
    RETURNING id INTO v_webauthn;
    UPDATE identity.webauthn_challenges SET consumed_at = now() WHERE id = v_webauthn;
    PERFORM pg_temp.assert_error(format(
        'UPDATE identity.webauthn_challenges SET consumed_at = now() WHERE id = %L', v_webauthn),
        'LG006', 'défi WebAuthn consommé deux fois');
    PERFORM pg_temp.assert_error(
        $q$INSERT INTO identity.webauthn_challenges (ceremony, challenge, expires_at) VALUES ('registration', repeat('B', 43), now() + interval '5 minutes')$q$,
        '23514', 'enregistrement WebAuthn sans utilisateur refusé');

    -- Passkey : compteur de signature non décroissant.
    INSERT INTO identity.webauthn_credentials (user_id, credential_id, public_key_cose, sign_count)
    VALUES (v_alice, sha256('cred'), '\x01', 10);
    PERFORM pg_temp.assert_error(
        $q$UPDATE identity.webauthn_credentials SET sign_count = 9 WHERE credential_id = sha256('cred')$q$,
        'LG006', 'compteur de passkey décroissant refusé (clonage)');
END;
$$;

-- Le rôle applicatif ne peut ni supprimer un défi ni en altérer le contenu.
GRANT SELECT ON fx_ids TO app_api;
SET LOCAL ROLE app_api;
DO $$
BEGIN
    PERFORM pg_temp.assert_error('DELETE FROM identity.login_challenges', '42501', 'app_api ne supprime pas les défis de connexion');
    PERFORM pg_temp.assert_error('UPDATE identity.device_challenges SET challenge = sha256(''x'')', '42501', 'app_api ne modifie pas un défi');
    PERFORM pg_temp.assert_true(identity.purge_expired_challenges() >= 0, 'purge des défis expirés exécutable');
END;
$$;
RESET ROLE;
