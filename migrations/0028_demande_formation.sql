-- =====================================================================
-- Demandes de formation d'un prospect (05/10/2026) : une ligne par formation
-- du catalogue souhaitée, avec nombre de participants, date souhaitée et note.
-- Remplace entreprise.formations_souhaitees (text[], 0026). STRICTEMENT interne :
-- même politique que note_suivi (consultant ou administrateur IFECARM GROUP),
-- jamais visible du client ni du prospect. Les slugs sont validés dans
-- l'application (catalogue JSON), comme avant.
-- Écriture : uniquement via definir_souhaits_prospect() (SECURITY DEFINER,
-- contrôle d'accès en écriture) ; ifecarm_app n'a que SELECT sur la table.
-- =====================================================================

CREATE TABLE demande_formation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  formation_slug  text        NOT NULL CHECK (char_length(formation_slug) BETWEEN 1 AND 200),
  nb_participants integer     CHECK (nb_participants BETWEEN 1 AND 10000),
  date_souhaitee  date,
  note            text        CHECK (note IS NULL OR char_length(note) <= 1000),
  cree_le         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, formation_slug)
);

ALTER TABLE demande_formation ENABLE ROW LEVEL SECURITY;

CREATE POLICY demandes_internes_ifecarm ON demande_formation FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              OR current_setting('app.platform_admin', true) = 'true'))
  WITH CHECK (est_consultant_ou_admin_courant()
         AND (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              OR current_setting('app.platform_admin', true) = 'true'));

GRANT SELECT ON demande_formation TO ifecarm_app;

-- Reprise de l'existant (slugs seuls, sans détail).
INSERT INTO demande_formation (entreprise_id, formation_slug)
SELECT id, unnest(formations_souhaitees) FROM entreprise WHERE cardinality(formations_souhaitees) > 0;

-- La vue d'ensemble dépend de la colonne : on la recrée sans elle.
DROP FUNCTION vue_ensemble_ifecarm();
ALTER TABLE entreprise DROP COLUMN formations_souhaitees;
DROP FUNCTION definir_souhaits_prospect(uuid, text[], text[]);

-- p_formations : tableau JSON d'objets {slug, nb_participants?, date_souhaitee?, note?}.
CREATE OR REPLACE FUNCTION definir_souhaits_prospect(p_id uuid, p_services text[], p_formations jsonb) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_formations jsonb := coalesce(p_formations, '[]'::jsonb);
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
  IF jsonb_typeof(v_formations) <> 'array' OR jsonb_array_length(v_formations) > 30 THEN
    RAISE EXCEPTION '30 formations au maximum.' USING ERRCODE = 'IF409';
  END IF;

  UPDATE entreprise SET
    services_souhaites = ARRAY(SELECT DISTINCT unnest(coalesce(p_services, '{}')) ORDER BY 1)
  WHERE id = p_id;

  DELETE FROM demande_formation WHERE entreprise_id = p_id;
  INSERT INTO demande_formation (entreprise_id, formation_slug, nb_participants, date_souhaitee, note)
  SELECT p_id, x.slug, x.nb_participants, x.date_souhaitee, NULLIF(btrim(x.note), '')
  FROM jsonb_to_recordset(v_formations)
    AS x(slug text, nb_participants integer, date_souhaitee date, note text)
  ON CONFLICT (entreprise_id, formation_slug) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], jsonb) TO ifecarm_app;

-- Même fonction qu'en 0027 ; formations_souhaitees (text[]) est maintenant dérivé de demande_formation.
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
    coalesce(cp.n, 0), cp.noms, e.services_souhaites,
    coalesce(df.slugs, '{}'::text[]),
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
    SELECT array_agg(d.formation_slug ORDER BY d.formation_slug) AS slugs
    FROM demande_formation d WHERE d.entreprise_id = e.id
  ) df ON true
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
