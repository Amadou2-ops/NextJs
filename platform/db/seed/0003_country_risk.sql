-- =============================================================================
-- Niveau de risque pays — valeurs de départ prudentes.
--
-- Juridictions faisant l'objet d'un « appel à l'action » du GAFI (liste noire)
-- au moment de la rédaction : Corée du Nord, Iran, Myanmar. Elles sont
-- marquées 'prohibited' : la contrainte countries_prohibited_closed interdit
-- alors toute ouverture à l'envoi ou à la réception.
--
-- AVANT LA MISE EN PRODUCTION, le responsable conformité DOIT revalider cette
-- liste (GAFI, OFAC, UE, ONU, HM Treasury, autorités locales de chaque
-- licence) et renseigner risk_reviewed_at. La liste « sous surveillance
-- renforcée » (liste grise) relève de risk_level = 'high' et se met à jour à
-- chaque plénière du GAFI.
-- =============================================================================
UPDATE ref.countries
   SET risk_level = 'prohibited',
       can_send = false,
       can_receive = false
 WHERE alpha2 IN ('KP', 'IR', 'MM')
   AND risk_level <> 'prohibited';
