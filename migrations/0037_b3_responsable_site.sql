-- =====================================================================
-- B3 : le responsable de site lit les déclarations NON ANONYMES de son site
-- (décision de l'utilisateur, 06/10/2026). Même principe que le responsable
-- QHSE (0035), limité aux sites pour lesquels il détient le rôle
-- « responsable_site » (role_utilisateur.site_id). Les déclarations anonymes
-- lui restent invisibles, sans exception ; une déclaration sans site aussi.
-- Périmètre volontairement limité aux déclarations (et, par la RLS de
-- piece_jointe_declaration, à leurs pièces jointes) : analyses, historique,
-- relances et actions restent aux responsables d'entreprise et à l'équipe.
-- =====================================================================

CREATE OR REPLACE FUNCTION est_responsable_du_site_courant(p_site uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_site IS NOT NULL AND EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    WHERE r.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
      AND r.role = 'responsable_site'
      AND r.site_id = p_site
      AND u.actif
      AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
$$;

REVOKE EXECUTE ON FUNCTION est_responsable_du_site_courant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION est_responsable_du_site_courant(uuid) TO ifecarm_app;

DROP POLICY lecture_declaration ON declaration;
CREATE POLICY lecture_declaration ON declaration FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant()
              OR est_responsable_registre_courant()
              OR (NOT anonyme AND declarant_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid)
              OR (NOT anonyme AND est_responsable_du_site_courant(site_id))));
