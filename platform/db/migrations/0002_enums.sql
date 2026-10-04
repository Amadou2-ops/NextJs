-- =============================================================================
-- 0002 — Types énumérés
--
-- Les énumérations figent le vocabulaire métier au niveau de la base : une
-- valeur inconnue envoyée par l'API est rejetée par PostgreSQL lui-même.
-- Ajout de valeur : ALTER TYPE ... ADD VALUE dans une nouvelle migration.
-- Suppression de valeur : interdite (l'historique doit rester lisible).
-- =============================================================================

-- ref ------------------------------------------------------------------------
CREATE TYPE ref.country_risk_level AS ENUM ('low', 'medium', 'high', 'prohibited');
CREATE TYPE ref.continent AS ENUM ('AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA');

-- identity -------------------------------------------------------------------
CREATE TYPE identity.user_status AS ENUM (
    'pending_verification',
    'active',
    'suspended',
    'closed'
);
CREATE TYPE identity.device_platform AS ENUM ('ios', 'android', 'web');
CREATE TYPE identity.device_key_algorithm AS ENUM ('ES256', 'EdDSA');
CREATE TYPE identity.attestation_type AS ENUM ('app_attest', 'play_integrity', 'none');
CREATE TYPE identity.session_audience AS ENUM ('mobile', 'web');
CREATE TYPE identity.otp_purpose AS ENUM (
    'phone_verification',
    'email_verification',
    'login',
    'step_up',
    'password_reset'
);
CREATE TYPE identity.otp_channel AS ENUM ('sms', 'email', 'whatsapp');

-- kyc ------------------------------------------------------------------------
CREATE TYPE kyc.kyc_tier AS ENUM ('tier_0', 'tier_1', 'tier_2', 'tier_3');
CREATE TYPE kyc.verification_status AS ENUM (
    'created',
    'pending_submission',
    'submitted',
    'in_review',
    'approved',
    'rejected',
    'resubmission_required',
    'expired'
);
CREATE TYPE kyc.provider AS ENUM ('smile_id', 'onfido');
CREATE TYPE kyc.job_type AS ENUM (
    'document_verification',
    'biometric_kyc',
    'enhanced_kyc',
    'video_liveness',
    'proof_of_address'
);
CREATE TYPE kyc.document_type AS ENUM (
    'passport',
    'national_id',
    'driving_licence',
    'residence_permit',
    'selfie_image',
    'selfie_video',
    'proof_of_address'
);
CREATE TYPE kyc.actor_type AS ENUM ('system', 'provider', 'admin', 'customer');

-- fx -------------------------------------------------------------------------
CREATE TYPE fx.rate_provider AS ENUM ('fixer', 'open_exchange_rates');

-- ledger ---------------------------------------------------------------------
CREATE TYPE ledger.normal_side AS ENUM ('debit', 'credit');
CREATE TYPE ledger.entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE ledger.account_status AS ENUM ('active', 'frozen', 'closed');
CREATE TYPE ledger.account_type AS ENUM (
    -- Passif : argent que nous devons au client.
    'customer_wallet',
    -- Passif : fonds client réservés pour un transfert en cours.
    'customer_hold',
    -- Actif : fonds détenus chez un prestataire (Stripe, Flutterwave, Thunes).
    'provider_settlement',
    -- Actif : encaissement initié chez un prestataire, pas encore réglé.
    'payin_clearing',
    -- Passif : paiement sortant ordonné, pas encore confirmé par le prestataire.
    'payout_clearing',
    -- Compte de position de change (un par devise), contrepartie des conversions.
    'fx_position',
    -- Produits : frais de transfert et marge de change.
    'fee_revenue',
    'fx_revenue',
    -- Charges : pertes sur rétrofacturation, frais prestataires.
    'chargeback_loss',
    'provider_fee_expense',
    -- Compte d'attente pour les écarts de rapprochement.
    'suspense',
    -- Capitaux propres / dotation opérationnelle.
    'equity'
);
CREATE TYPE ledger.journal_type AS ENUM (
    'wallet_funding',
    'transfer_hold',
    'transfer_hold_release',
    'transfer_fee',
    'transfer_fx_conversion',
    'transfer_payout',
    'payout_settlement',
    'payout_failure',
    'refund',
    'chargeback',
    'provider_fee',
    'reversal',
    'adjustment',
    'capital_injection'
);

-- transfers ------------------------------------------------------------------
CREATE TYPE transfers.transfer_status AS ENUM (
    'created',
    'awaiting_funding',
    'funding_processing',
    'funded',
    'compliance_review',
    'payout_pending',
    'payout_processing',
    'completed',
    'payout_failed',
    'cancelled',
    'refund_pending',
    'refunded'
);
CREATE TYPE transfers.funding_method AS ENUM (
    'wallet_balance',
    'card',
    'bank_transfer',
    'mobile_money',
    'apple_pay',
    'google_pay'
);
CREATE TYPE transfers.payout_method AS ENUM (
    'bank_account',
    'mobile_money',
    'cash_pickup',
    'card',
    'wallet'
);
CREATE TYPE transfers.actor_type AS ENUM ('customer', 'admin', 'system', 'provider');

-- payments -------------------------------------------------------------------
CREATE TYPE payments.provider AS ENUM ('stripe', 'flutterwave', 'thunes');
CREATE TYPE payments.provider_environment AS ENUM ('sandbox', 'live');
CREATE TYPE payments.payment_direction AS ENUM ('payin', 'payout', 'refund');
CREATE TYPE payments.attempt_status AS ENUM (
    'pending',
    'requires_action',
    'processing',
    'succeeded',
    'failed',
    'cancelled',
    'reversed'
);
CREATE TYPE payments.circuit_state AS ENUM ('closed', 'open', 'half_open');

-- integrations ---------------------------------------------------------------
CREATE TYPE integrations.webhook_source AS ENUM (
    'stripe',
    'flutterwave',
    'thunes',
    'smile_id',
    'onfido'
);
CREATE TYPE integrations.webhook_status AS ENUM (
    'received',
    'processing',
    'processed',
    'failed',
    'ignored'
);
CREATE TYPE integrations.webhook_rejection_reason AS ENUM (
    'missing_signature',
    'invalid_signature',
    'timestamp_out_of_tolerance',
    'malformed_payload',
    'unknown_source'
);
CREATE TYPE integrations.outbox_status AS ENUM (
    'pending',
    'processing',
    'published',
    'failed',
    'dead'
);

-- aml ------------------------------------------------------------------------
CREATE TYPE aml.severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE aml.alert_status AS ENUM (
    'open',
    'under_review',
    'escalated',
    'closed_false_positive',
    'closed_confirmed'
);
CREATE TYPE aml.case_status AS ENUM ('open', 'investigating', 'sar_filed', 'closed');
CREATE TYPE aml.screening_subject AS ENUM ('user', 'recipient');
CREATE TYPE aml.screening_status AS ENUM (
    'clear',
    'potential_match',
    'confirmed_match',
    'false_positive',
    'error'
);
CREATE TYPE aml.risk_level AS ENUM ('low', 'medium', 'high', 'unacceptable');

-- backoffice -----------------------------------------------------------------
CREATE TYPE backoffice.admin_status AS ENUM ('invited', 'active', 'suspended', 'disabled');
CREATE TYPE backoffice.approval_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired',
    'executed'
);

-- audit ----------------------------------------------------------------------
CREATE TYPE audit.actor_type AS ENUM ('customer', 'admin', 'system', 'provider');
