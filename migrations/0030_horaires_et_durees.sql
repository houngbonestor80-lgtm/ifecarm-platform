-- =====================================================================
-- Horaires et durées décidés par le consultant / l'administrateur (05/10/2026).
--   1. Inspection : heure de début et heure de fin (heure locale du site,
--      sans fuseau : la date existe déjà, date_inspection).
--   2. Session de formation : heures de début et de fin de journée, et durée
--      totale décidée pour CETTE session (duree_heures). La durée du
--      catalogue du site (« 2 Jours », « 5H », « Sur mesure »…) n'est qu'une
--      indication : formation.duree_jours devient facultative, le texte du
--      site reste dans duree_libelle.
-- Aucune table ni politique nouvelle : les colonnes héritent de la RLS de
-- inspection (0008) et de session_formation (0004/0029).
-- =====================================================================

ALTER TABLE inspection
  ADD COLUMN heure_debut time,
  ADD COLUMN heure_fin   time,
  ADD CONSTRAINT inspection_heures_coherentes CHECK (
    (heure_fin IS NULL OR heure_debut IS NOT NULL)
    AND (heure_fin IS NULL OR heure_fin > heure_debut)
  );

ALTER TABLE formation ALTER COLUMN duree_jours DROP NOT NULL;

ALTER TABLE session_formation
  ADD COLUMN heure_debut  time,
  ADD COLUMN heure_fin    time,
  ADD COLUMN duree_heures numeric(5,1) CHECK (duree_heures > 0 AND duree_heures <= 1000),
  ADD CONSTRAINT session_heures_coherentes CHECK (
    (heure_fin IS NULL OR heure_debut IS NOT NULL)
    AND (heure_fin IS NULL OR heure_fin > heure_debut)
  );
