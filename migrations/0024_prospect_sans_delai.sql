-- =====================================================================
-- Plus de délai sur l'accès d'un prospect (30/09/2026) : le consultant qui
-- crée un prospect y garde un accès en écriture SANS date de fin (celui-ci
-- peut toujours être retiré par l'administrateur). Le paramètre
-- p_duree_acces_jours est conservé pour la compatibilité mais ignoré.
-- Les accès déjà accordés sur des prospects perdent leur échéance.
-- =====================================================================

CREATE OR REPLACE FUNCTION creer_prospect(
  p_nom text,
  p_pays text,
  p_secteur text DEFAULT NULL,
  p_duree_acces_jours integer DEFAULT 90
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_id uuid;
  v_actifs integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'creer_prospect : utilisateur non identifié.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = v_uid
      AND r.role IN ('consultant_ifecarm', 'admin_plateforme')
      AND u.actif
      AND e.interne
  ) THEN
    RAISE EXCEPTION 'creer_prospect : réservé aux consultants IFECARM.';
  END IF;

  IF p_nom IS NULL OR btrim(p_nom) = '' OR p_pays IS NULL OR btrim(p_pays) = '' THEN
    RAISE EXCEPTION 'creer_prospect : nom et pays obligatoires.';
  END IF;
  IF p_duree_acces_jours IS NULL OR p_duree_acces_jours NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'creer_prospect : durée d''accès hors bornes (1 à 365 jours).';
  END IF;

  SELECT count(*) INTO v_actifs
  FROM acces_consultant a
  JOIN entreprise e ON e.id = a.entreprise_id
  WHERE a.utilisateur_id = v_uid
    AND e.statut_relation = 'prospect'
    AND e.desactive_le IS NULL;
  IF v_actifs >= 50 THEN
    RAISE EXCEPTION 'creer_prospect : plafond de 50 prospects actifs atteint.';
  END IF;

  INSERT INTO entreprise (nom, pays, secteur, statut_relation)
  VALUES (btrim(p_nom), btrim(p_pays), p_secteur, 'prospect')
  RETURNING id INTO v_id;

  INSERT INTO abonnement_module (entreprise_id, module)
  VALUES (v_id, 'inspections'), (v_id, 'tableau_bord');

  INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le)
  VALUES (v_uid, v_id, true, NULL);

  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (v_uid, NULL, 'creer_prospect', 'entreprise', v_id,
          jsonb_build_object('duree_acces_jours', p_duree_acces_jours));

  RETURN v_id;
END;
$$;

UPDATE acces_consultant SET fin_le = NULL
WHERE fin_le IS NOT NULL
  AND entreprise_id IN (SELECT id FROM entreprise WHERE statut_relation = 'prospect');
