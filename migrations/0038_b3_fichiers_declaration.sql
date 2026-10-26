-- =====================================================================
-- B3 : les fichiers (photos) d'une déclaration suivent la visibilité de la
-- déclaration (06/10/2026). Trou constaté avant les écrans : fichier n'avait
-- qu'une politique « tout le tenant lit tout », donc la photo d'une
-- déclaration ANONYME (ou d'un autre déclarant) était lisible par tout
-- utilisateur de l'entreprise, avec son nom et l'identifiant de la déclaration.
--   - Lecture : un fichier d'objet_type 'declaration' n'est lisible que si la
--     déclaration l'est (RLS de declaration appliquée dans le EXISTS).
--   - Suppression : réservée à l'équipe IFECARM pour ces fichiers.
--   - Aucune échappatoire platform_admin sur ces fichiers (comme declaration).
--   - Écriture des autres fichiers : inchangée (tenant, ou platform_admin).
-- L'insertion se fait sans RETURNING côté application (un déclarant ne relit pas
-- la photo d'une déclaration anonyme) ; televerse_par reste NULL pour ces
-- fichiers (sinon la colonne désanonymiserait la photo).
-- =====================================================================

DROP POLICY cloisonnement_fichier ON fichier;

CREATE POLICY lecture_fichier ON fichier FOR SELECT
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
     AND (objet_type IS DISTINCT FROM 'declaration'
          OR EXISTS (SELECT 1 FROM declaration d WHERE d.id = fichier.objet_id)))
    OR (current_setting('app.platform_admin', true) = 'true' AND objet_type IS DISTINCT FROM 'declaration')
  );

CREATE POLICY ajout_fichier ON fichier FOR INSERT
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR (current_setting('app.platform_admin', true) = 'true' AND objet_type IS DISTINCT FROM 'declaration')
  );

CREATE POLICY maj_fichier ON fichier FOR UPDATE
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid AND objet_type IS DISTINCT FROM 'declaration')
    OR (current_setting('app.platform_admin', true) = 'true' AND objet_type IS DISTINCT FROM 'declaration')
  )
  WITH CHECK (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid AND objet_type IS DISTINCT FROM 'declaration')
    OR (current_setting('app.platform_admin', true) = 'true' AND objet_type IS DISTINCT FROM 'declaration')
  );

CREATE POLICY suppression_fichier ON fichier FOR DELETE
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
     AND (objet_type IS DISTINCT FROM 'declaration' OR est_consultant_ou_admin_courant()))
    OR (current_setting('app.platform_admin', true) = 'true' AND objet_type IS DISTINCT FROM 'declaration')
  );
