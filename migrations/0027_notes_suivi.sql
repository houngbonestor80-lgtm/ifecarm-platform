-- =====================================================================
-- Notes de suivi internes par client ou prospect (30/09/2026) : le consultant
-- et l'administrateur y consignent comment l'entreprise se comporte
-- (relances, intérêt, réactivité…). JAMAIS visibles du client ni du prospect :
-- la politique RLS exige un utilisateur interne IFECARM GROUP (consultant ou
-- administrateur) EN PLUS du cloisonnement par entreprise.
-- La vue d'ensemble expose le nombre de notes et la dernière (fonction
-- recréée, type modifié).
-- =====================================================================

CREATE TABLE note_suivi (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  -- Auteur : lien conservé si le compte disparaît, et nom figé (l'auteur n'est
  -- pas lisible depuis le tenant du client, cf. nom_utilisateur_courant()).
  auteur_id     uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  auteur_nom    text        NOT NULL,
  contenu       text        NOT NULL CHECK (char_length(btrim(contenu)) BETWEEN 1 AND 2000),
  cree_le       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_note_suivi_entreprise ON note_suivi(entreprise_id, cree_le DESC);

ALTER TABLE note_suivi ENABLE ROW LEVEL SECURITY;

CREATE POLICY notes_internes_ifecarm ON note_suivi FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              OR current_setting('app.platform_admin', true) = 'true'))
  WITH CHECK (est_consultant_ou_admin_courant()
         AND (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              OR current_setting('app.platform_admin', true) = 'true'));

GRANT SELECT, INSERT, DELETE ON note_suivi TO ifecarm_app;

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
  formations_souhaitees text[],
  notes_nb integer,
  derniere_note text,
  derniere_note_le timestamptz
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
    coalesce(cp.n, 0), cp.noms, e.services_souhaites, e.formations_souhaitees,
    coalesce(nt.n, 0), nt.derniere, nt.derniere_le
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
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS n,
           (SELECT s.contenu FROM note_suivi s WHERE s.entreprise_id = e.id ORDER BY s.cree_le DESC LIMIT 1) AS derniere,
           max(s.cree_le) AS derniere_le
    FROM note_suivi s WHERE s.entreprise_id = e.id
  ) nt ON true
  WHERE NOT e.interne AND e.desactive_le IS NULL
    AND (v_admin OR EXISTS (
      SELECT 1 FROM acces_consultant a
      WHERE a.utilisateur_id = v_uid AND a.entreprise_id = e.id AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)))
  ORDER BY e.nom;
END;
$$;

REVOKE EXECUTE ON FUNCTION vue_ensemble_ifecarm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vue_ensemble_ifecarm() TO ifecarm_app;
