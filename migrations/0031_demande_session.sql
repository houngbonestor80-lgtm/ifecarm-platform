-- =====================================================================
-- Lien demande de formation ↔ session (05/10/2026) : une demande devient
-- « planifiée » quand une session lui est liée ; le formulaire de session se
-- préremplit depuis la demande. Une demande = une seule session (UNIQUE).
-- La clé composite (session_id, entreprise_id) interdit de lier la session
-- d'une autre entreprise ; la suppression de la session délie la demande
-- (SET NULL sur session_id seul, entreprise_id est NOT NULL).
-- L'écriture reste réservée à l'équipe IFECARM (politique de 0028).
-- =====================================================================

ALTER TABLE demande_formation
  ADD COLUMN session_id uuid,
  ADD CONSTRAINT uq_demande_formation_session UNIQUE (session_id),
  ADD CONSTRAINT demande_session_meme_entreprise_fkey
    FOREIGN KEY (session_id, entreprise_id) REFERENCES session_formation (id, entreprise_id) ON DELETE SET NULL (session_id);

-- Seule la colonne de lien est modifiable en direct ; le reste passe par definir_souhaits_prospect().
GRANT UPDATE (session_id) ON demande_formation TO ifecarm_app;

-- Même fonction qu'en 0028, mais les demandes sont mises à jour sur place :
-- le lien vers une session est conservé, et une demande déjà planifiée ne
-- peut pas être retirée de la liste.
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

  IF EXISTS (
    SELECT 1 FROM demande_formation d
    WHERE d.entreprise_id = p_id AND d.session_id IS NOT NULL
      AND d.formation_slug NOT IN (SELECT x.slug FROM jsonb_to_recordset(v_formations) AS x(slug text))
  ) THEN
    RAISE EXCEPTION 'Une demande déjà planifiée dans une session ne peut pas être retirée.' USING ERRCODE = 'IF409';
  END IF;

  UPDATE entreprise SET
    services_souhaites = ARRAY(SELECT DISTINCT unnest(coalesce(p_services, '{}')) ORDER BY 1)
  WHERE id = p_id;

  DELETE FROM demande_formation d
  WHERE d.entreprise_id = p_id
    AND d.formation_slug NOT IN (SELECT x.slug FROM jsonb_to_recordset(v_formations) AS x(slug text));

  INSERT INTO demande_formation (entreprise_id, formation_slug, nb_participants, date_souhaitee, note)
  SELECT p_id, x.slug, x.nb_participants, x.date_souhaitee, NULLIF(btrim(x.note), '')
  FROM jsonb_to_recordset(v_formations)
    AS x(slug text, nb_participants integer, date_souhaitee date, note text)
  ON CONFLICT (entreprise_id, formation_slug) DO UPDATE
    SET nb_participants = EXCLUDED.nb_participants,
        date_souhaitee  = EXCLUDED.date_souhaitee,
        note            = EXCLUDED.note;
END;
$$;
