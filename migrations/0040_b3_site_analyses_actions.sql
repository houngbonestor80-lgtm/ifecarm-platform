-- =====================================================================
-- B3 : le responsable de site lit aussi les analyses des causes et les
-- actions correctives d'origine « declaration » rattachées aux déclarations
-- de son site (décision de l'utilisateur, 06/10/2026). Même périmètre que
-- 0037 : déclarations NON anonymes de ses sites, jamais l'anonyme, jamais une
-- déclaration sans site. L'historique et les relances restent réservés aux
-- responsables d'entreprise et à l'équipe IFECARM. Lecture seule : l'écriture
-- reste à l'équipe IFECARM (0035).
-- La condition porte sur la déclaration d'origine, relue sous sa propre RLS.
-- =====================================================================

CREATE OR REPLACE FUNCTION declaration_lisible_par_responsable_site(p_declaration uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM declaration d
    WHERE d.id = p_declaration
      AND d.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
      AND NOT d.anonyme
      AND est_responsable_du_site_courant(d.site_id))
$$;
REVOKE EXECUTE ON FUNCTION declaration_lisible_par_responsable_site(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration_lisible_par_responsable_site(uuid) TO ifecarm_app;

DROP POLICY lecture_analyse ON analyse_cause;
CREATE POLICY lecture_analyse ON analyse_cause FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant()
              OR est_responsable_registre_courant()
              OR declaration_lisible_par_responsable_site(declaration_id)));

DROP POLICY lecture_action ON action_corrective;
CREATE POLICY lecture_action ON action_corrective FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (origine_type <> 'declaration'
              OR est_consultant_ou_admin_courant()
              OR est_responsable_registre_courant()
              OR declaration_lisible_par_responsable_site(origine_id)));
