-- =====================================================================
-- Autodiagnostic pour les prospects (08/10/2026). Décision de l'utilisateur : le consultant peut mener un autodiagnostic dès la
-- première visite chez une entreprise pas encore cliente (l'historique suit à la conversion en client).
--   - le déclencheur verifier_modules_prospect() (0008) accepte ce module pour un prospect (et pour le repasser en prospect) ;
--   - creer_prospect() active désormais 'autodiagnostic' en plus de 'inspections' et 'tableau_bord' (reste de la fonction : 0024) ;
--   - les prospects déjà créés reçoivent le module (sans toucher à un abonnement existant, ni le réactiver s'il a été coupé).
-- =====================================================================

-- Modules permis à un prospect : inspections, tableau de bord, autodiagnostic.
CREATE OR REPLACE FUNCTION verifier_modules_prospect() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'abonnement_module' THEN
    IF NEW.actif
       AND NEW.module NOT IN ('inspections', 'tableau_bord', 'autodiagnostic')
       AND EXISTS (SELECT 1 FROM entreprise e
                   WHERE e.id = NEW.entreprise_id AND e.statut_relation = 'prospect') THEN
      RAISE EXCEPTION
        'Le module % ne peut pas être activé pour un prospect : convertir d''abord l''entreprise en client.',
        NEW.module;
    END IF;
  ELSE  -- entreprise : passage à 'prospect' alors que d'autres modules sont actifs
    IF NEW.statut_relation = 'prospect' AND EXISTS (
         SELECT 1 FROM abonnement_module m
         WHERE m.entreprise_id = NEW.id AND m.actif
           AND m.module NOT IN ('inspections', 'tableau_bord', 'autodiagnostic')) THEN
      RAISE EXCEPTION 'Cette entreprise a des modules actifs réservés aux clients : impossible de la repasser en prospect.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  VALUES (v_id, 'inspections'), (v_id, 'tableau_bord'), (v_id, 'autodiagnostic');

  INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le)
  VALUES (v_uid, v_id, true, NULL);

  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (v_uid, NULL, 'creer_prospect', 'entreprise', v_id,
          jsonb_build_object('duree_acces_jours', p_duree_acces_jours));

  RETURN v_id;
END;
$$;

INSERT INTO abonnement_module (entreprise_id, module)
SELECT e.id, 'autodiagnostic' FROM entreprise e
WHERE e.statut_relation = 'prospect'
ON CONFLICT (entreprise_id, module) DO NOTHING;
