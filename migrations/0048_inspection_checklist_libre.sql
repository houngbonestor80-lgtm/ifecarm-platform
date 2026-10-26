-- =====================================================================
-- B5 : checklist LIBRE (08/10/2026). Décision de l'utilisateur : l'inspecteur n'est pas limité aux modèles par défaut ;
-- il peut écrire ses propres points de contrôle, au démarrage d'une inspection (sans modèle) ou en cours de route.
--
--   - inspection.modele_id devient facultatif : une inspection « libre » n'a pas de modèle (son intitulé est dans
--     intitule_modele). Les inspections existantes gardent leur modèle.
--   - item_inspection.personnalise : point écrit par l'inspecteur (ajouté à une inspection, ou checklist libre).
--   - Règles (déclencheur) : ajouter un point, modifier le libellé d'un point PERSONNALISÉ ou le supprimer n'est possible que
--     tant que l'inspection est en brouillon ou en cours. Les points issus d'un modèle restent figés (libellé non modifiable,
--     non supprimables : « non applicable » existe pour les écarter). 200 points au maximum par inspection.
--   - La suppression d'une inspection (cascade) reste libre : le déclencheur laisse passer quand l'inspection n'existe plus.
-- =====================================================================

ALTER TABLE inspection ALTER COLUMN modele_id DROP NOT NULL;

ALTER TABLE item_inspection ADD COLUMN personnalise boolean NOT NULL DEFAULT false;
ALTER TABLE item_inspection ADD CONSTRAINT item_inspection_libelle_longueur CHECK (length(btrim(libelle)) BETWEEN 1 AND 500);

GRANT DELETE ON item_inspection TO ifecarm_app;

CREATE OR REPLACE FUNCTION proteger_item_inspection() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inspection uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
  v_statut text;
BEGIN
  -- Inspection de la MÊME entreprise seulement : sinon la clé étrangère composite refuse (ce déclencheur n'a rien à dire).
  SELECT statut INTO v_statut FROM inspection
   WHERE id = v_inspection AND entreprise_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entreprise_id ELSE NEW.entreprise_id END;

  IF TG_OP = 'DELETE' THEN
    -- Cascade depuis l'inspection (suppression, purge, suppression d'entreprise) : toujours permis.
    IF v_statut IS NULL THEN RETURN OLD; END IF;
    IF NOT OLD.personnalise THEN
      RAISE EXCEPTION 'Un point issu d''un modèle ne se supprime pas : marquez-le « non applicable ».' USING ERRCODE = 'IF409';
    END IF;
    IF v_statut NOT IN ('brouillon', 'en_cours') THEN
      RAISE EXCEPTION 'Inspection clôturée : ses points ne changent plus.' USING ERRCODE = 'IF409';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_statut IS NULL THEN RETURN NEW; END IF;
    IF v_statut NOT IN ('brouillon', 'en_cours') THEN
      RAISE EXCEPTION 'Inspection clôturée : on n''y ajoute plus de point.' USING ERRCODE = 'IF409';
    END IF;
    IF (SELECT count(*) FROM item_inspection WHERE inspection_id = v_inspection) >= 200 THEN
      RAISE EXCEPTION '200 points de contrôle au maximum par inspection.' USING ERRCODE = 'IF409';
    END IF;
    RETURN NEW;
  END IF;

  IF v_statut IS NULL THEN RETURN NEW; END IF;

  -- UPDATE : le libellé, l'ordre et l'origine ne changent que pour un point personnalisé d'une inspection ouverte.
  IF NEW.libelle IS DISTINCT FROM OLD.libelle OR NEW.ordre IS DISTINCT FROM OLD.ordre
     OR NEW.personnalise IS DISTINCT FROM OLD.personnalise OR NEW.item_modele_id IS DISTINCT FROM OLD.item_modele_id
     OR NEW.inspection_id IS DISTINCT FROM OLD.inspection_id THEN
    -- item_modele_id passe à NULL quand un modèle est supprimé (ON DELETE SET NULL) : sans effet sur le libellé figé.
    IF NEW.libelle IS NOT DISTINCT FROM OLD.libelle AND NEW.ordre IS NOT DISTINCT FROM OLD.ordre
       AND NEW.personnalise IS NOT DISTINCT FROM OLD.personnalise AND NEW.inspection_id IS NOT DISTINCT FROM OLD.inspection_id
       AND NEW.item_modele_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NOT OLD.personnalise OR NEW.personnalise IS DISTINCT FROM OLD.personnalise OR NEW.inspection_id IS DISTINCT FROM OLD.inspection_id THEN
      RAISE EXCEPTION 'Le libellé d''un point issu d''un modèle est figé.' USING ERRCODE = 'IF409';
    END IF;
    IF v_statut NOT IN ('brouillon', 'en_cours') THEN
      RAISE EXCEPTION 'Inspection clôturée : ses points ne changent plus.' USING ERRCODE = 'IF409';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION proteger_item_inspection() FROM PUBLIC;
CREATE TRIGGER trg_item_inspection_proteger BEFORE INSERT OR UPDATE OR DELETE ON item_inspection
  FOR EACH ROW EXECUTE FUNCTION proteger_item_inspection();
