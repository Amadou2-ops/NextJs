-- =============================================================================
-- Routage KYC initial (idempotent).
--
--   * Par défaut (tout pays de résidence) : Onfido — pièce d'identité + selfie
--     de vivacité (niveau 1), preuve de domicile (niveau 2).
--   * Résidents d'Afrique : Smile ID, qui couvre les pièces africaines et,
--     pour les pays listés, la confrontation biométrique avec le registre
--     d'état civil de l'autorité émettrice (Biometric KYC). Onfido reste la
--     règle de repli si Smile ID n'est pas configuré.
--
-- Les priorités et l'activation se modifient ensuite depuis l'administration.
-- =============================================================================
INSERT INTO kyc.provider_routes (country_of_residence, tier, provider, job_type, priority)
VALUES (NULL, 'tier_1', 'onfido', 'document_verification', 100),
       (NULL, 'tier_2', 'onfido', 'proof_of_address', 100)
ON CONFLICT ON CONSTRAINT provider_routes_unique DO NOTHING;

INSERT INTO kyc.provider_routes (country_of_residence, tier, provider, job_type, priority)
SELECT c.alpha2, 'tier_1', 'smile_id', 'biometric_kyc', 10
  FROM ref.countries c
 WHERE c.alpha2 IN ('NG', 'GH', 'KE', 'ZA', 'UG')
ON CONFLICT ON CONSTRAINT provider_routes_unique DO NOTHING;

INSERT INTO kyc.provider_routes (country_of_residence, tier, provider, job_type, priority)
SELECT c.alpha2, 'tier_1', 'smile_id', 'document_verification', 20
  FROM ref.countries c
 WHERE c.continent = 'AF'
ON CONFLICT ON CONSTRAINT provider_routes_unique DO NOTHING;
