-- =====================================================================
-- Gestion des modèles d'inspection (arbitrage du 29/09/2026 : « Admin +
-- consultants ») — catalogue IFECARM (entreprise_id NULL) par
-- admin_plateforme, modèles propres à une entreprise par le consultant.
-- Les politiques RLS de 0008 couvrent déjà ces écritures ; il manquait le
-- droit de supprimer un modèle JAMAIS utilisé (saisie d'essai ou erreur) :
-- inspection.modele_id est ON DELETE RESTRICT, un modèle utilisé ne peut
-- donc qu'être archivé (actif = false). Les inspections passées gardent
-- leurs libellés figés (item_inspection.libelle).
-- =====================================================================

GRANT DELETE ON modele_inspection TO ifecarm_app;

ALTER TABLE modele_inspection
  ADD CONSTRAINT modele_textes_bornes CHECK (
    char_length(intitule) BETWEEN 1 AND 200 AND char_length(domaine) BETWEEN 1 AND 80
    AND (description IS NULL OR char_length(description) <= 2000));
