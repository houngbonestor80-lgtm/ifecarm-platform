-- =====================================================================
-- Notes internes sur les objets de la plateforme (06/10/2026) : l'équipe
-- IFECARM peut écrire une note libre sur une inspection, une non-conformité,
-- une action corrective, une session de formation, un équipement ou une
-- déclaration. Comme les notes de suivi (0027) : INTERNES, jamais visibles du
-- client ni du prospect, quel que soit son rôle.
--   - RLS : équipe IFECARM (consultant ou admin) dans l'entreprise active ;
--     aucune échappatoire pour le client.
--   - Auteur et nom posés par le serveur (déclencheur) : une note ne peut pas
--     être écrite au nom d'un autre ; le nom est figé (lisible même si le compte
--     disparaît).
--   - Immuable : pas de UPDATE. Suppression : l'auteur, ou l'administrateur.
--   - L'objet désigné doit appartenir à la même entreprise (déclencheur) ; les
--     notes disparaissent avec l'objet (déclencheurs de nettoyage).
-- =====================================================================

CREATE TABLE note_objet (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  objet_type    text        NOT NULL
                CHECK (objet_type IN ('inspection', 'non_conformite', 'action_corrective', 'session_formation', 'equipement', 'declaration')),
  objet_id      uuid        NOT NULL,
  auteur_id     uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  auteur_nom    text        NOT NULL,
  contenu       text        NOT NULL CHECK (char_length(btrim(contenu)) BETWEEN 1 AND 2000),
  cree_le       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_note_objet ON note_objet(objet_type, objet_id, cree_le);
CREATE INDEX idx_note_objet_entreprise ON note_objet(entreprise_id, cree_le DESC);

-- Auteur posé par le serveur ; l'objet doit exister dans la même entreprise.
CREATE OR REPLACE FUNCTION preparer_note_objet() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_ok boolean;
BEGIN
  NEW.auteur_id := v_uid;
  NEW.auteur_nom := coalesce(nom_utilisateur_courant(), 'Compte supprimé');
  v_ok := CASE NEW.objet_type
    WHEN 'inspection'        THEN EXISTS (SELECT 1 FROM inspection x        WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    WHEN 'non_conformite'    THEN EXISTS (SELECT 1 FROM non_conformite x    WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    WHEN 'action_corrective' THEN EXISTS (SELECT 1 FROM action_corrective x WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    WHEN 'session_formation' THEN EXISTS (SELECT 1 FROM session_formation x WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    WHEN 'equipement'        THEN EXISTS (SELECT 1 FROM equipement x        WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    WHEN 'declaration'       THEN EXISTS (SELECT 1 FROM declaration x       WHERE x.id = NEW.objet_id AND x.entreprise_id = NEW.entreprise_id)
    ELSE false END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'L''objet désigné n''existe pas dans cette entreprise.' USING ERRCODE = 'IF404';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION preparer_note_objet() FROM PUBLIC;
CREATE TRIGGER trg_note_objet_preparer BEFORE INSERT ON note_objet
  FOR EACH ROW EXECUTE FUNCTION preparer_note_objet();

-- Les notes suivent la vie de leur objet.
CREATE OR REPLACE FUNCTION supprimer_notes_objet() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM note_objet WHERE objet_type = TG_ARGV[0] AND objet_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE EXECUTE ON FUNCTION supprimer_notes_objet() FROM PUBLIC;
CREATE TRIGGER trg_notes_inspection        AFTER DELETE ON inspection        FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('inspection');
CREATE TRIGGER trg_notes_non_conformite    AFTER DELETE ON non_conformite    FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('non_conformite');
CREATE TRIGGER trg_notes_action_corrective AFTER DELETE ON action_corrective FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('action_corrective');
CREATE TRIGGER trg_notes_session_formation AFTER DELETE ON session_formation FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('session_formation');
CREATE TRIGGER trg_notes_equipement        AFTER DELETE ON equipement        FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('equipement');
CREATE TRIGGER trg_notes_declaration       AFTER DELETE ON declaration       FOR EACH ROW EXECUTE FUNCTION supprimer_notes_objet('declaration');

ALTER TABLE note_objet ENABLE ROW LEVEL SECURITY;

CREATE POLICY lecture_note_objet ON note_objet FOR SELECT
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ajout_note_objet ON note_objet FOR INSERT
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY suppression_note_objet ON note_objet FOR DELETE
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (auteur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid OR est_admin_plateforme_courant()));

GRANT SELECT, INSERT, DELETE ON note_objet TO ifecarm_app;
