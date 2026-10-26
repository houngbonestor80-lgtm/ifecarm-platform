-- =====================================================================
-- Formations qui intéressent un prospect (30/09/2026) : choisies dans le
-- catalogue de formations IFECARM GROUP (fiches identifiées par leur slug,
-- catalogue embarqué dans src/formations/catalogue.json — la validation des
-- slugs se fait dans l'application). Remplace definir_services_souhaites
-- (0025) par une fonction qui écrit services ET formations.
-- =====================================================================

ALTER TABLE entreprise
  ADD COLUMN formations_souhaitees text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(formations_souhaitees) <= 30);

DROP FUNCTION definir_services_souhaites(uuid, text[]);

CREATE OR REPLACE FUNCTION definir_souhaits_prospect(p_id uuid, p_services text[], p_formations text[]) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM entreprise WHERE id = p_id AND NOT interne AND desactive_le IS NULL) THEN
    RAISE EXCEPTION 'Entreprise introuvable.' USING ERRCODE = 'IF404';
  END IF;
  IF NOT est_admin_plateforme_courant() AND NOT EXISTS (
    SELECT 1 FROM acces_consultant a
    WHERE a.utilisateur_id = v_uid AND a.entreprise_id = p_id AND a.ecriture
      AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)
      AND est_consultant_ou_admin_courant()) THEN
    RAISE EXCEPTION 'Accès en écriture à cette entreprise requis.' USING ERRCODE = 'IF403';
  END IF;
  IF NOT (coalesce(p_services, '{}') <@ ARRAY['inspection', 'formation', 'audit', 'conseil']::text[]) THEN
    RAISE EXCEPTION 'Service inconnu.' USING ERRCODE = 'IF409';
  END IF;
  IF cardinality(coalesce(p_formations, '{}')) > 30 THEN
    RAISE EXCEPTION '30 formations au maximum.' USING ERRCODE = 'IF409';
  END IF;
  UPDATE entreprise SET
    services_souhaites = ARRAY(SELECT DISTINCT unnest(coalesce(p_services, '{}')) ORDER BY 1),
    formations_souhaitees = ARRAY(SELECT DISTINCT unnest(coalesce(p_formations, '{}')) ORDER BY 1)
  WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], text[]) TO ifecarm_app;

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
  noms_comptes text,
  services_souhaites text[],
  formations_souhaitees text[]
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
    coalesce(cp.n, 0), cp.noms, e.services_souhaites, e.formations_souhaitees
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
