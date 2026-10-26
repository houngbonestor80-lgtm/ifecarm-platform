-- =====================================================================
-- Inspections : intervenants nommés et photos (demande du 29/09/2026).
--
-- 1. Noms saisis sur l'inspection, repris dans le rapport PDF :
--    * inspecteur_nom      : la personne qui a réalisé l'inspection (pas
--      forcément le titulaire du compte : saisie libre, pré-remplie) ;
--    * representant_client : l'interlocuteur côté client ou prospect qui a
--      accompagné l'inspection sur place.
--    Texte libre plutôt qu'une référence à `utilisateur` : le consultant
--    appartient à l'entreprise IFECARM, sa fiche est invisible (RLS) dans le
--    tenant du client — le nom doit donc être porté par l'inspection.
--
-- 2. Photos : table `fichier` existante (objet_type / objet_id), avec
--    objet_type 'item_inspection' ou 'non_conformite'. Aucune colonne
--    nouvelle ; la RLS cloisonnement_fichier cloisonne déjà par entreprise.
-- =====================================================================

ALTER TABLE inspection
  ADD COLUMN inspecteur_nom      text CHECK (char_length(inspecteur_nom) <= 200),
  ADD COLUMN representant_client text CHECK (char_length(representant_client) <= 200);

-- Nom de l'utilisateur connecté (app.utilisateur_id), pour pré-remplir
-- « Inspection réalisée par ». SECURITY DEFINER car la fiche d'un consultant
-- n'est pas visible depuis le tenant du client ; ne renvoie QUE ce nom-là.
CREATE OR REPLACE FUNCTION nom_utilisateur_courant() RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT nom FROM utilisateur
  WHERE id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
$$;

REVOKE EXECUTE ON FUNCTION nom_utilisateur_courant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nom_utilisateur_courant() TO ifecarm_app;

CREATE INDEX IF NOT EXISTS idx_fichier_objet_inspection ON fichier(objet_type, objet_id)
  WHERE objet_type IN ('item_inspection', 'non_conformite');
