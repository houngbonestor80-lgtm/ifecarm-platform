-- =====================================================================
-- Vue d'ensemble IFECARM : ajout du nombre de comptes actifs par entreprise
-- et des noms (pour repérer d'un coup d'œil les clients qui ont un accès).
-- Même périmètre et mêmes règles qu'en 0020 ; le type de retour change, la
-- fonction est donc recréée.
-- =====================================================================

DROP FUNCTION vue_ensemble_ifecarm();

CREATE OR REPLACE FUNCTION vue_ensemble_ifecarm()
RETURNS TABLE (
  entreprise_id uuid,
  nom text,
  statut_relation text,
  inspections_en_cours integer,
  inspections_terminees_90j integer,
  taux_conformite_90j numeric,
  nc_critique integer,
  nc_majeure integer,
  nc_mineure integer,
  actions_ouvertes integer,
  actions_en_retard integer,
  equipements_en_retard integer,
  comptes_actifs integer,
  noms_comptes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_admin boolean;
BEGIN
  SELECT coalesce(bool_or(r.role = 'admin_plateforme'), false) INTO v_admin
  FROM role_utilisateur r
  JOIN utilisateur u ON u.id = r.utilisateur_id
  JOIN entreprise e ON e.id = u.entreprise_id
  WHERE r.utilisateur_id = v_uid AND u.actif AND e.interne
    AND r.role IN ('admin_plateforme', 'consultant_ifecarm');
  IF v_admin IS NULL OR NOT EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = v_uid AND u.actif AND e.interne
      AND r.role IN ('admin_plateforme', 'consultant_ifecarm')
  ) THEN
    RAISE EXCEPTION 'Vue d''ensemble réservée aux consultants et administrateurs IFECARM GROUP.';
  END IF;

  RETURN QUERY
  SELECT
    e.id, e.nom, e.statut_relation,
    coalesce(ins.en_cours, 0), coalesce(ins.terminees_90j, 0),
    round(it.conformes::numeric / NULLIF(it.conformes + it.non_conformes, 0), 4),
    coalesce(nc.critique, 0), coalesce(nc.majeure, 0), coalesce(nc.mineure, 0),
    coalesce(ac.ouvertes, 0), coalesce(ac.en_retard, 0),
    coalesce(eq.en_retard, 0),
    coalesce(cp.n, 0), cp.noms
  FROM entreprise e
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE statut IN ('brouillon', 'en_cours'))::integer AS en_cours,
      count(*) FILTER (WHERE statut = 'terminee' AND terminee_le >= now() - interval '90 days')::integer AS terminees_90j
    FROM inspection WHERE inspection.entreprise_id = e.id
  ) ins ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE i.resultat = 'conforme')::integer AS conformes,
      count(*) FILTER (WHERE i.resultat = 'non_conforme')::integer AS non_conformes
    FROM item_inspection i JOIN inspection s ON s.id = i.inspection_id
    WHERE i.entreprise_id = e.id AND s.statut = 'terminee' AND s.terminee_le >= now() - interval '90 days'
  ) it ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE n.gravite = 'critique')::integer AS critique,
      count(*) FILTER (WHERE n.gravite = 'majeure')::integer AS majeure,
      count(*) FILTER (WHERE n.gravite = 'mineure')::integer AS mineure
    FROM non_conformite n JOIN inspection s ON s.id = n.inspection_id
    WHERE n.entreprise_id = e.id AND s.statut <> 'annulee'
      AND NOT EXISTS (SELECT 1 FROM action_corrective a
                      WHERE a.origine_type = 'inspection' AND a.origine_id = n.id AND a.statut IN ('realisee', 'verifiee'))
  ) nc ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE statut IN ('a_faire', 'en_cours'))::integer AS ouvertes,
      count(*) FILTER (WHERE statut IN ('a_faire', 'en_cours') AND echeance < CURRENT_DATE)::integer AS en_retard
    FROM action_corrective WHERE action_corrective.entreprise_id = e.id
  ) ac ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS en_retard
    FROM equipement WHERE equipement.entreprise_id = e.id AND actif AND prochaine_verif < CURRENT_DATE
  ) eq ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS n, string_agg(u.nom, ', ' ORDER BY u.nom) AS noms
    FROM utilisateur u WHERE u.entreprise_id = e.id AND u.actif
  ) cp ON true
  WHERE NOT e.interne AND e.desactive_le IS NULL
    AND (v_admin OR EXISTS (
      SELECT 1 FROM acces_consultant a
      WHERE a.utilisateur_id = v_uid AND a.entreprise_id = e.id AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)))
  ORDER BY e.nom;
END;
$$;

REVOKE EXECUTE ON FUNCTION vue_ensemble_ifecarm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vue_ensemble_ifecarm() TO ifecarm_app;
