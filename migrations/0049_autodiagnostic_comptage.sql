-- =====================================================================
-- B1 : nombre d'évaluations par référentiel (08/10/2026).
-- L'administrateur gère le catalogue hors de toute entreprise (withPlatformAdmin) : la RLS de `autodiagnostic` ne lui montre
-- aucune évaluation, il ne pouvait donc pas savoir qu'un référentiel avait servi. Comptage pur, SECURITY DEFINER, réservé à
-- l'administrateur de plateforme : aucune évaluation n'est exposée, seulement leur nombre.
-- =====================================================================
CREATE OR REPLACE FUNCTION nombre_evaluations_autodiagnostic(p_code text) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.platform_admin', true) IS DISTINCT FROM 'true' AND NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur de la plateforme.' USING ERRCODE = 'IF403';
  END IF;
  RETURN (SELECT count(*)::integer FROM autodiagnostic WHERE referentiel_code = p_code);
END;
$$;
REVOKE EXECUTE ON FUNCTION nombre_evaluations_autodiagnostic(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nombre_evaluations_autodiagnostic(text) TO ifecarm_app;
