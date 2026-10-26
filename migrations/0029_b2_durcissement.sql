-- =====================================================================
-- B2 formations : durcissement avant les écrans (05/10/2026).
-- Revue de 0004 / 0006 / 0007 avec le niveau d'exigence de demande_formation :
--   1. Écriture réservée à l'équipe IFECARM GROUP au niveau RLS : client et
--      prospect = consultation seule (décision de l'utilisateur), mais 0004
--      laissait tout utilisateur du tenant écrire (le contrôle n'existait que
--      dans l'application). Lecture : inchangée (le client voit ses propres
--      sessions, participants, émargements, attestations).
--   2. Slug du catalogue IFECARM unique : UNIQUE (entreprise_id, slug) n'empêche
--      pas deux lignes (NULL, slug), car NULL ≠ NULL en SQL.
--   3. Même entreprise de bout en bout : session ↔ formation (catalogue ou
--      propre à l'entreprise) et site ; participant ↔ session et salarié
--      (clés étrangères composites, comme 0006/0007).
--   4. Attestation : colonnes figées à l'émission protégées par trigger
--      (seuls statut, motif, date d'annulation et PDF évoluent) ; une
--      attestation annulée ne redevient pas valide.
-- Les GRANT de 0004 sont conservés (pas de DELETE sur attestation, emargement,
-- session ; alerte_recyclage en SELECT/INSERT seulement).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RLS : lecture par tenant, écriture par équipe IFECARM dans le tenant
-- ---------------------------------------------------------------------

DROP POLICY cloisonnement_session     ON session_formation;
DROP POLICY cloisonnement_participant ON participant;
DROP POLICY cloisonnement_emargement  ON emargement;
DROP POLICY cloisonnement_attestation ON attestation;
DROP POLICY cloisonnement_alerte      ON alerte_recyclage;

CREATE POLICY lecture_session ON session_formation FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_session ON session_formation FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_participant ON participant FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_participant ON participant FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_emargement ON emargement FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_emargement ON emargement FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_attestation ON attestation FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_attestation ON attestation FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_alerte ON alerte_recyclage FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_alerte ON alerte_recyclage FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- formation : le catalogue (entreprise_id NULL) reste lisible par tous et
-- modifiable par admin_plateforme seulement ; une formation propre à une
-- entreprise n'est plus modifiable que par l'équipe IFECARM.
DROP POLICY ecriture_formation ON formation;
CREATE POLICY ecriture_formation ON formation FOR ALL
  USING (
    (est_consultant_ou_admin_courant()
     AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    (est_consultant_ou_admin_courant()
     AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
    OR current_setting('app.platform_admin', true) = 'true'
  );

-- ---------------------------------------------------------------------
-- 2. Slug unique dans le catalogue IFECARM
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM formation WHERE entreprise_id IS NULL GROUP BY slug HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0029 : slugs en double dans le catalogue IFECARM (entreprise_id NULL) — à dédoublonner avant migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX uq_formation_catalogue_slug ON formation(slug) WHERE entreprise_id IS NULL;

-- ---------------------------------------------------------------------
-- 3. Même entreprise de bout en bout
-- ---------------------------------------------------------------------

-- 3a. session ↔ formation (catalogue ou même entreprise) et site : trigger,
-- car la formation du catalogue a entreprise_id NULL (une FK composite ne
-- peut pas l'exprimer).
CREATE OR REPLACE FUNCTION verifier_session_formation_site() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM formation f WHERE f.id = NEW.formation_id
                 AND (f.entreprise_id IS NULL OR f.entreprise_id = NEW.entreprise_id)) THEN
    RAISE EXCEPTION 'La formation doit appartenir au catalogue IFECARM ou à la même entreprise que la session.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM site s WHERE s.id = NEW.site_id AND s.entreprise_id = NEW.entreprise_id) THEN
    RAISE EXCEPTION 'Le site doit appartenir à la même entreprise que la session.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_formation_site BEFORE INSERT OR UPDATE OF entreprise_id, formation_id, site_id ON session_formation
  FOR EACH ROW EXECUTE FUNCTION verifier_session_formation_site();

-- 3b. participant ↔ session et salarié : clés étrangères composites.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM participant p JOIN session_formation s ON s.id = p.session_id WHERE s.entreprise_id <> p.entreprise_id)
     OR EXISTS (SELECT 1 FROM participant p JOIN salarie s ON s.id = p.salarie_id WHERE s.entreprise_id <> p.entreprise_id) THEN
    RAISE EXCEPTION '0029 : des participants existants pointent vers une session ou un salarié d''une autre entreprise — à corriger avant migration.';
  END IF;
END $$;

ALTER TABLE session_formation ADD CONSTRAINT uq_session_formation_id_entreprise UNIQUE (id, entreprise_id);
ALTER TABLE salarie           ADD CONSTRAINT uq_salarie_id_entreprise           UNIQUE (id, entreprise_id);

ALTER TABLE participant DROP CONSTRAINT participant_session_id_fkey;
ALTER TABLE participant DROP CONSTRAINT participant_salarie_id_fkey;
ALTER TABLE participant
  ADD CONSTRAINT participant_session_meme_entreprise_fkey
  FOREIGN KEY (session_id, entreprise_id) REFERENCES session_formation (id, entreprise_id) ON DELETE CASCADE,
  ADD CONSTRAINT participant_salarie_meme_entreprise_fkey
  FOREIGN KEY (salarie_id, entreprise_id) REFERENCES salarie (id, entreprise_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 4. Attestation : colonnes figées, annulation irréversible
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION proteger_attestation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.entreprise_id, NEW.participant_id, NEW.code_verification, NEW.nom_salarie, NEW.prenom_salarie,
      NEW.intitule_formation, NEW.nom_entreprise, NEW.date_debut, NEW.date_fin, NEW.duree_libelle,
      NEW.formateur, NEW.emise_le, NEW.expire_le)
     IS DISTINCT FROM
     (OLD.entreprise_id, OLD.participant_id, OLD.code_verification, OLD.nom_salarie, OLD.prenom_salarie,
      OLD.intitule_formation, OLD.nom_entreprise, OLD.date_debut, OLD.date_fin, OLD.duree_libelle,
      OLD.formateur, OLD.emise_le, OLD.expire_le) THEN
    RAISE EXCEPTION 'Une attestation émise est figée : seuls son statut, son motif d''annulation et son PDF peuvent changer.' USING ERRCODE = 'IF409';
  END IF;
  IF OLD.statut = 'annulee' AND NEW.statut <> 'annulee' THEN
    RAISE EXCEPTION 'Une attestation annulée ne peut pas redevenir valide.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_attestation_figee BEFORE UPDATE ON attestation
  FOR EACH ROW EXECUTE FUNCTION proteger_attestation();
