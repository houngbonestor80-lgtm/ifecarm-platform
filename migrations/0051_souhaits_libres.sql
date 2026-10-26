-- =====================================================================
-- Souhaits d'un prospect : valeurs écrites à la main (08/10/2026, principe « jamais limité aux listes par défaut »).
--   - entreprise.service_autre : un service souhaité en plus des quatre cases (inspection, formation, audit, conseil) ;
--   - demande_formation.intitule : une formation voulue qui n'est pas dans le catalogue du site. Son identifiant (slug) commence
--     par « libre- » ; l'intitulé est obligatoire pour elle et seulement pour elle.
-- Reste de la fonction : celle de la migration 0031 (une demande déjà planifiée ne peut pas être retirée).
-- =====================================================================

ALTER TABLE entreprise
  ADD COLUMN service_autre text CHECK (service_autre IS NULL OR char_length(service_autre) BETWEEN 1 AND 300);

ALTER TABLE demande_formation
  ADD COLUMN intitule text CHECK (intitule IS NULL OR char_length(btrim(intitule)) BETWEEN 1 AND 200),
  ADD CONSTRAINT demande_formation_libre_coherente CHECK ((formation_slug LIKE 'libre-%') = (intitule IS NOT NULL));

DROP FUNCTION definir_souhaits_prospect(uuid, text[], jsonb);

CREATE FUNCTION definir_souhaits_prospect(p_id uuid, p_services text[], p_formations jsonb, p_service_autre text DEFAULT NULL) RETURNS void
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
  IF p_service_autre IS NOT NULL AND char_length(btrim(p_service_autre)) > 300 THEN
    RAISE EXCEPTION 'Service souhaité : 300 caractères au maximum.' USING ERRCODE = 'IF409';
  END IF;
  IF jsonb_typeof(v_formations) <> 'array' OR jsonb_array_length(v_formations) > 30 THEN
    RAISE EXCEPTION '30 formations au maximum.' USING ERRCODE = 'IF409';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_formations) AS x(slug text, intitule text)
             WHERE (x.slug LIKE 'libre-%') <> (NULLIF(btrim(x.intitule), '') IS NOT NULL)) THEN
    RAISE EXCEPTION 'Une formation hors catalogue doit avoir un intitulé (et lui seul).' USING ERRCODE = 'IF409';
  END IF;

  IF EXISTS (
    SELECT 1 FROM demande_formation d
    WHERE d.entreprise_id = p_id AND d.session_id IS NOT NULL
      AND d.formation_slug NOT IN (SELECT x.slug FROM jsonb_to_recordset(v_formations) AS x(slug text))
  ) THEN
    RAISE EXCEPTION 'Une demande déjà planifiée dans une session ne peut pas être retirée.' USING ERRCODE = 'IF409';
  END IF;

  UPDATE entreprise SET
    services_souhaites = ARRAY(SELECT DISTINCT unnest(coalesce(p_services, '{}')) ORDER BY 1),
    service_autre = NULLIF(btrim(coalesce(p_service_autre, '')), '')
  WHERE id = p_id;

  DELETE FROM demande_formation d
  WHERE d.entreprise_id = p_id
    AND d.formation_slug NOT IN (SELECT x.slug FROM jsonb_to_recordset(v_formations) AS x(slug text));

  INSERT INTO demande_formation (entreprise_id, formation_slug, intitule, nb_participants, date_souhaitee, note)
  SELECT p_id, x.slug, NULLIF(btrim(x.intitule), ''), x.nb_participants, x.date_souhaitee, NULLIF(btrim(x.note), '')
  FROM jsonb_to_recordset(v_formations)
    AS x(slug text, intitule text, nb_participants integer, date_souhaitee date, note text)
  ON CONFLICT (entreprise_id, formation_slug) DO UPDATE
    SET nb_participants = EXCLUDED.nb_participants,
        date_souhaitee  = EXCLUDED.date_souhaitee,
        note            = EXCLUDED.note,
        intitule        = EXCLUDED.intitule;
END;
$$;

REVOKE EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION definir_souhaits_prospect(uuid, text[], jsonb, text) TO ifecarm_app;
