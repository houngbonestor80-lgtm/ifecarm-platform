-- =====================================================================
-- Registre des équipements et EPI (demande du 30/09/2026).
--
-- La table equipement existe depuis 0001 mais n'avait aucun écran. On
-- ajoute ce qui manque au suivi :
--   * derniere_verif : date de la dernière vérification enregistrée
--     (prochaine_verif = derniere_verif + periodicite_mois) ;
--   * affecte_a      : porteur d'un EPI ou service utilisateur (texte libre,
--     le salarié n'a pas forcément de compte).
-- Suppression : autorisée pour un équipement jamais inspecté (saisie d'essai
-- ou erreur) ; la clé étrangère ON DELETE RESTRICT de inspection refuse
-- sinon, et l'application propose alors de le retirer (actif = false).
-- La RLS cloisonnement_equipement (FOR ALL) couvre déjà DELETE.
-- =====================================================================

ALTER TABLE equipement
  ADD COLUMN derniere_verif date,
  ADD COLUMN affecte_a text CHECK (char_length(affecte_a) <= 200),
  ADD CONSTRAINT equipement_periodicite_bornes CHECK (periodicite_mois IS NULL OR periodicite_mois BETWEEN 1 AND 120),
  ADD CONSTRAINT equipement_textes_bornes CHECK (
    char_length(type) BETWEEN 1 AND 80 AND char_length(designation) BETWEEN 1 AND 200
    AND (numero_serie IS NULL OR char_length(numero_serie) <= 100));

GRANT DELETE ON equipement TO ifecarm_app;
