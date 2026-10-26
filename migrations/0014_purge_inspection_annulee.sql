-- =====================================================================
-- Suppression définitive d'une inspection RANGÉE (annulée) — demande du
-- 30/09/2026 : pouvoir effacer les inspections d'essai, NC et plans
-- d'action compris, avant la mise en service réelle.
--
-- Deux temps, volontairement : une inspection probante (clôturée ou avec
-- NC) est d'abord rangée (annulation, 0012), puis seulement ensuite
-- supprimée définitivement. Le journal d'audit garde la trace.
--
-- ifecarm_app n'a toujours AUCUN droit DELETE sur non_conformite ni
-- action_corrective : la purge passe uniquement par cette fonction,
-- limitée à l'entreprise courante (app.entreprise_id) et au statut annulee.
-- =====================================================================

CREATE OR REPLACE FUNCTION empecher_suppression_inspection_probante() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.statut NOT IN ('brouillon', 'en_cours', 'annulee') THEN
    RAISE EXCEPTION 'Inspection % : une inspection clôturée doit d''abord être rangée (annulée) avant suppression (statut actuel : %).', OLD.id, OLD.statut;
  END IF;
  IF EXISTS (SELECT 1 FROM non_conformite nc WHERE nc.inspection_id = OLD.id) THEN
    RAISE EXCEPTION 'Inspection % : elle comporte des non-conformités, elle doit être annulée et non supprimée.', OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

-- Renvoie les clés de stockage des fichiers effacés (nettoyage S3 côté appli).
CREATE OR REPLACE FUNCTION purger_inspection_annulee(p_id uuid) RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entreprise uuid := NULLIF(current_setting('app.entreprise_id', true), '')::uuid;
  v_nc uuid[];
  v_actions uuid[];
  v_fichiers uuid[];
  v_cles text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inspection WHERE id = p_id AND entreprise_id = v_entreprise AND statut = 'annulee') THEN
    RAISE EXCEPTION 'Inspection % : introuvable ou non rangée.', p_id;
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_nc FROM non_conformite WHERE inspection_id = p_id;
  SELECT coalesce(array_agg(id), '{}') INTO v_actions FROM action_corrective
    WHERE origine_type = 'inspection' AND origine_id = ANY (v_nc) AND entreprise_id = v_entreprise;

  SELECT coalesce(array_agg(f.id), '{}'), coalesce(array_agg(f.cle_stockage), '{}') INTO v_fichiers, v_cles
  FROM fichier f
  WHERE f.entreprise_id = v_entreprise AND (
       (f.objet_type = 'item_inspection' AND f.objet_id IN (SELECT id FROM item_inspection WHERE inspection_id = p_id))
    OR (f.objet_type = 'non_conformite'  AND f.objet_id = ANY (v_nc))
    OR (f.objet_type = 'action_corrective' AND f.objet_id = ANY (v_actions))
    OR f.id IN (SELECT fichier_id FROM rapport_inspection WHERE inspection_id = p_id));

  DELETE FROM action_corrective WHERE id = ANY (v_actions);   -- relances en cascade
  DELETE FROM non_conformite WHERE id = ANY (v_nc);
  DELETE FROM inspection WHERE id = p_id;                     -- points, rapports en cascade
  DELETE FROM fichier WHERE id = ANY (v_fichiers);
  RETURN v_cles;
END;
$$;

REVOKE EXECUTE ON FUNCTION purger_inspection_annulee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purger_inspection_annulee(uuid) TO ifecarm_app;
