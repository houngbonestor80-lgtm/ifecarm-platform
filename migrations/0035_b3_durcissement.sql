-- =====================================================================
-- B3 registre de sécurité : durcissement avant les écrans (06/10/2026).
-- Revue de 0005 avec le niveau d'exigence de 0029 / 0032 (B2). Décisions de
-- l'utilisateur :
--   ÉCRITURE  Un utilisateur du client peut seulement DÉCLARER (insertion).
--             Qualification, analyse des causes, actions, vérification et
--             commentaires de suivi : équipe IFECARM (consultant ou admin).
--   LECTURE   Par rôle. Équipe IFECARM, responsable_qhse et admin_entreprise
--             lisent tout. Un déclarant ne lit que SES déclarations non
--             anonymes ; une déclaration anonyme n'est lisible que par les
--             responsables et l'équipe IFECARM. Analyses, historique et
--             relances : mêmes lecteurs (pas les déclarants simples).
--   FIGER     Faits (type, date, lieu, service, description, victime, arrêt,
--             site) modifiables tant que le statut est « a_qualifier ».
--             Anonymat, déclarant, référence, clé client : jamais.
--   ACTIONS   Table partagée avec B5 : écriture réservée à l'équipe IFECARM
--             (comme B5 le faisait déjà côté application) ; les actions
--             d'origine « declaration » ne sont lisibles que par les rôles
--             ci-dessus, celles d'origine « inspection » restent visibles de
--             tout le tenant (le client reçoit son plan d'action).
-- Ajoute aussi : références croisées bloquées entre entreprises (clés
-- étrangères composites + déclencheurs pour les comptes utilisateurs, dont les
-- consultants appartiennent à IFECARM), historique des statuts tenu PAR LA
-- BASE (déclencheur), cohérence des statuts, et lecture d'un rejeu hors ligne
-- sans exposer le contenu.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Garde-fou : refuse d'appliquer si des données existantes violent les
--    nouvelles contraintes (message explicite plutôt qu'un échec obscur).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM declaration d
   WHERE (d.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM site s WHERE s.id = d.site_id AND s.entreprise_id = d.entreprise_id))
      OR (d.salarie_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM salarie s WHERE s.id = d.salarie_id AND s.entreprise_id = d.entreprise_id));
  IF n > 0 THEN RAISE EXCEPTION '% déclaration(s) référencent un site ou salarié d''une autre entreprise : à corriger avant 0035.', n; END IF;

  SELECT count(*) INTO n FROM piece_jointe_declaration p
   WHERE NOT EXISTS (SELECT 1 FROM fichier f WHERE f.id = p.fichier_id AND f.entreprise_id = p.entreprise_id)
      OR NOT EXISTS (SELECT 1 FROM declaration d WHERE d.id = p.declaration_id AND d.entreprise_id = p.entreprise_id);
  IF n > 0 THEN RAISE EXCEPTION '% pièce(s) jointe(s) incohérente(s) (entreprise) : à corriger avant 0035.', n; END IF;

  SELECT count(*) INTO n FROM action_corrective a
   WHERE (a.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM site s WHERE s.id = a.site_id AND s.entreprise_id = a.entreprise_id))
      OR (a.preuve_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fichier f WHERE f.id = a.preuve_id AND f.entreprise_id = a.entreprise_id));
  IF n > 0 THEN RAISE EXCEPTION '% action(s) corrective(s) référencent un site ou fichier d''une autre entreprise : à corriger avant 0035.', n; END IF;

  SELECT count(*) INTO n FROM analyse_cause x WHERE NOT EXISTS (SELECT 1 FROM declaration d WHERE d.id = x.declaration_id AND d.entreprise_id = x.entreprise_id);
  IF n > 0 THEN RAISE EXCEPTION '% analyse(s) incohérente(s) : à corriger avant 0035.', n; END IF;
  SELECT count(*) INTO n FROM historique_declaration x WHERE NOT EXISTS (SELECT 1 FROM declaration d WHERE d.id = x.declaration_id AND d.entreprise_id = x.entreprise_id);
  IF n > 0 THEN RAISE EXCEPTION '% historique(s) incohérent(s) : à corriger avant 0035.', n; END IF;
  SELECT count(*) INTO n FROM relance_action x WHERE NOT EXISTS (SELECT 1 FROM action_corrective a WHERE a.id = x.action_id AND a.entreprise_id = x.entreprise_id);
  IF n > 0 THEN RAISE EXCEPTION '% relance(s) incohérente(s) : à corriger avant 0035.', n; END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 1. Références croisées : même entreprise de bout en bout
-- ---------------------------------------------------------------------
ALTER TABLE declaration       ADD CONSTRAINT declaration_id_entreprise_unique UNIQUE (id, entreprise_id);
ALTER TABLE action_corrective ADD CONSTRAINT action_corrective_id_entreprise_unique UNIQUE (id, entreprise_id);

ALTER TABLE declaration DROP CONSTRAINT declaration_site_id_fkey;
ALTER TABLE declaration ADD CONSTRAINT declaration_site_meme_entreprise_fkey
  FOREIGN KEY (site_id, entreprise_id) REFERENCES site (id, entreprise_id) ON DELETE SET NULL (site_id);
ALTER TABLE declaration DROP CONSTRAINT declaration_salarie_id_fkey;
ALTER TABLE declaration ADD CONSTRAINT declaration_salarie_meme_entreprise_fkey
  FOREIGN KEY (salarie_id, entreprise_id) REFERENCES salarie (id, entreprise_id) ON DELETE SET NULL (salarie_id);

ALTER TABLE piece_jointe_declaration DROP CONSTRAINT piece_jointe_declaration_declaration_id_fkey;
ALTER TABLE piece_jointe_declaration ADD CONSTRAINT piece_jointe_declaration_meme_entreprise_fkey
  FOREIGN KEY (declaration_id, entreprise_id) REFERENCES declaration (id, entreprise_id) ON DELETE CASCADE;
ALTER TABLE piece_jointe_declaration DROP CONSTRAINT piece_jointe_declaration_fichier_id_fkey;
ALTER TABLE piece_jointe_declaration ADD CONSTRAINT piece_jointe_fichier_meme_entreprise_fkey
  FOREIGN KEY (fichier_id, entreprise_id) REFERENCES fichier (id, entreprise_id) ON DELETE CASCADE;

ALTER TABLE analyse_cause DROP CONSTRAINT analyse_cause_declaration_id_fkey;
ALTER TABLE analyse_cause ADD CONSTRAINT analyse_cause_meme_entreprise_fkey
  FOREIGN KEY (declaration_id, entreprise_id) REFERENCES declaration (id, entreprise_id) ON DELETE CASCADE;

ALTER TABLE historique_declaration DROP CONSTRAINT historique_declaration_declaration_id_fkey;
ALTER TABLE historique_declaration ADD CONSTRAINT historique_meme_entreprise_fkey
  FOREIGN KEY (declaration_id, entreprise_id) REFERENCES declaration (id, entreprise_id) ON DELETE CASCADE;

ALTER TABLE action_corrective DROP CONSTRAINT action_corrective_site_id_fkey;
ALTER TABLE action_corrective ADD CONSTRAINT action_site_meme_entreprise_fkey
  FOREIGN KEY (site_id, entreprise_id) REFERENCES site (id, entreprise_id) ON DELETE SET NULL (site_id);
ALTER TABLE action_corrective DROP CONSTRAINT action_corrective_preuve_id_fkey;
ALTER TABLE action_corrective ADD CONSTRAINT action_preuve_meme_entreprise_fkey
  FOREIGN KEY (preuve_id, entreprise_id) REFERENCES fichier (id, entreprise_id) ON DELETE SET NULL (preuve_id);

ALTER TABLE relance_action DROP CONSTRAINT relance_action_action_id_fkey;
ALTER TABLE relance_action ADD CONSTRAINT relance_action_meme_entreprise_fkey
  FOREIGN KEY (action_id, entreprise_id) REFERENCES action_corrective (id, entreprise_id) ON DELETE CASCADE;

-- Cohérence des champs d'arrêt et de l'analyse.
ALTER TABLE declaration ADD CONSTRAINT declaration_arret_coherent
  CHECK ((type <> 'accident_avec_arret' OR arret_travail IS NOT FALSE)
         AND (jours_arret IS NULL OR arret_travail IS TRUE));
ALTER TABLE analyse_cause ADD CONSTRAINT analyse_etapes_tableau CHECK (jsonb_typeof(etapes) = 'array');

-- ---------------------------------------------------------------------
-- 2. Fonctions d'appui (SECURITY DEFINER, search_path fixé, EXECUTE retiré à PUBLIC)
-- ---------------------------------------------------------------------

-- Responsable du registre du client : admin_entreprise ou responsable_qhse, de l'entreprise active.
CREATE OR REPLACE FUNCTION est_responsable_registre_courant() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    WHERE r.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
      AND r.role IN ('admin_entreprise', 'responsable_qhse')
      AND u.actif
      AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
$$;

-- Un compte référencé par le registre appartient à l'entreprise OU à IFECARM (consultants).
CREATE OR REPLACE FUNCTION utilisateur_du_perimetre(p_utilisateur uuid, p_entreprise uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM utilisateur u JOIN entreprise e ON e.id = u.entreprise_id
    WHERE u.id = p_utilisateur AND (u.entreprise_id = p_entreprise OR e.interne))
$$;

-- Pièces jointes : on peut joindre une photo à une déclaration encore « à qualifier » de son
-- entreprise même quand on ne peut pas la relire (déclaration anonyme). L'identifiant, aléatoire,
-- n'est connu que de l'auteur et de l'équipe.
CREATE OR REPLACE FUNCTION declaration_ouverte_aux_pieces(p_declaration uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM declaration d
    WHERE d.id = p_declaration AND d.statut = 'a_qualifier'
      AND d.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
$$;

-- Rejeu d'une synchronisation hors ligne : renvoie id et référence (jamais le contenu) de la
-- déclaration portant cette clé client, sans exiger le droit de la lire (anonymat préservé).
CREATE OR REPLACE FUNCTION chercher_declaration_par_cle(p_cle text) RETURNS TABLE (id uuid, reference text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, d.reference FROM declaration d
  WHERE d.cle_client = p_cle
    AND d.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
$$;

REVOKE EXECUTE ON FUNCTION est_responsable_registre_courant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION utilisateur_du_perimetre(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION declaration_ouverte_aux_pieces(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chercher_declaration_par_cle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION est_responsable_registre_courant() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION utilisateur_du_perimetre(uuid, uuid) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION declaration_ouverte_aux_pieces(uuid) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION chercher_declaration_par_cle(text) TO ifecarm_app;

-- ---------------------------------------------------------------------
-- 3. RLS : lecture par rôle, écriture équipe IFECARM, déclaration ouverte au client
-- ---------------------------------------------------------------------
DROP POLICY cloisonnement_declaration ON declaration;
DROP POLICY cloisonnement_piece_jointe ON piece_jointe_declaration;
DROP POLICY cloisonnement_analyse ON analyse_cause;
DROP POLICY cloisonnement_action ON action_corrective;
DROP POLICY cloisonnement_relance ON relance_action;
DROP POLICY cloisonnement_historique ON historique_declaration;

-- declaration ----------------------------------------------------------
CREATE POLICY lecture_declaration ON declaration FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant()
              OR est_responsable_registre_courant()
              OR (NOT anonyme AND declarant_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid)));

-- Création : tout utilisateur de l'entreprise, sous sa propre identité ou anonymement ; jamais
-- déjà qualifiée. L'équipe IFECARM peut saisir pour le compte d'un autre déclarant.
CREATE POLICY creation_declaration ON declaration FOR INSERT
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              AND statut = 'a_qualifier'
              AND gravite IS NULL AND frequence IS NULL AND qualifie_par IS NULL AND qualifie_le IS NULL
              AND motif_sans_suite IS NULL
              AND (est_consultant_ou_admin_courant()
                   OR (anonyme AND declarant_id IS NULL)
                   OR (NOT anonyme AND declarant_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid)));

CREATE POLICY maj_declaration ON declaration FOR UPDATE
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- piece_jointe_declaration ----------------------------------------------
CREATE POLICY lecture_piece_jointe ON piece_jointe_declaration FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND EXISTS (SELECT 1 FROM declaration d WHERE d.id = declaration_id));  -- RLS de declaration appliquée
CREATE POLICY ajout_piece_jointe ON piece_jointe_declaration FOR INSERT
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
              AND (est_consultant_ou_admin_courant() OR declaration_ouverte_aux_pieces(declaration_id)));
CREATE POLICY suppression_piece_jointe ON piece_jointe_declaration FOR DELETE
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- analyse_cause ------------------------------------------------------------
CREATE POLICY lecture_analyse ON analyse_cause FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));
CREATE POLICY ecriture_analyse ON analyse_cause FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- action_corrective (partagée avec B5) --------------------------------------
CREATE POLICY lecture_action ON action_corrective FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (origine_type <> 'declaration' OR est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));
CREATE POLICY ecriture_action ON action_corrective FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- relance_action -------------------------------------------------------------
CREATE POLICY lecture_relance ON relance_action FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));
CREATE POLICY ajout_relance ON relance_action FOR INSERT
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- historique_declaration : les lignes de statut sont écrites par le déclencheur ci-dessous ;
-- l'équipe IFECARM ajoute seulement des commentaires (statut inchangé).
CREATE POLICY lecture_historique ON historique_declaration FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));
CREATE POLICY commentaire_historique ON historique_declaration FOR INSERT
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND statut_avant = statut_apres AND commentaire IS NOT NULL);

-- ---------------------------------------------------------------------
-- 4. Déclencheurs : comptes du périmètre, figer, cohérence, historique
-- ---------------------------------------------------------------------

-- Comptes référencés (déclarant, qualifieur, auteur d'analyse, responsable, vérificateur).
CREATE OR REPLACE FUNCTION verifier_utilisateurs_registre() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_col text;
  v_id  text;
BEGIN
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    v_id := to_jsonb(NEW) ->> v_col;
    IF v_id IS NOT NULL AND NOT utilisateur_du_perimetre(v_id::uuid, NEW.entreprise_id) THEN
      RAISE EXCEPTION 'Le compte référencé (%) n''appartient ni à l''entreprise ni à IFECARM.', v_col USING ERRCODE = 'IF409';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION verifier_utilisateurs_registre() FROM PUBLIC;

CREATE TRIGGER trg_declaration_comptes BEFORE INSERT OR UPDATE ON declaration
  FOR EACH ROW EXECUTE FUNCTION verifier_utilisateurs_registre('declarant_id', 'qualifie_par');
CREATE TRIGGER trg_analyse_comptes BEFORE INSERT OR UPDATE ON analyse_cause
  FOR EACH ROW EXECUTE FUNCTION verifier_utilisateurs_registre('realisee_par');
CREATE TRIGGER trg_action_comptes BEFORE INSERT OR UPDATE ON action_corrective
  FOR EACH ROW EXECUTE FUNCTION verifier_utilisateurs_registre('responsable_id', 'verifiee_par');

-- Figer une déclaration, valider les transitions de statut, qualifier côté serveur.
-- Transitions : a_qualifier → en_analyse | en_action | sans_suite ; en_analyse → en_action |
-- cloturee | sans_suite ; en_action → en_analyse | cloturee. cloturee et sans_suite sont définitifs.
CREATE OR REPLACE FUNCTION proteger_declaration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  IF OLD.statut IN ('cloturee', 'sans_suite') THEN
    RAISE EXCEPTION 'Une déclaration clôturée ou classée sans suite est figée.' USING ERRCODE = 'IF409';
  END IF;

  -- Jamais modifiables : identité de la ligne, anonymat, déclarant, référence, origine de la saisie.
  IF (NEW.id, NEW.entreprise_id, NEW.reference, NEW.cle_client, NEW.anonyme, NEW.declarant_id, NEW.saisi_hors_ligne, NEW.cree_le)
     IS DISTINCT FROM
     (OLD.id, OLD.entreprise_id, OLD.reference, OLD.cle_client, OLD.anonyme, OLD.declarant_id, OLD.saisi_hors_ligne, OLD.cree_le) THEN
    RAISE EXCEPTION 'L''identité, la référence, l''anonymat et le déclarant d''une déclaration ne changent jamais.' USING ERRCODE = 'IF409';
  END IF;

  -- Faits : modifiables seulement tant que la déclaration est « à qualifier ».
  IF OLD.statut <> 'a_qualifier' AND
     (NEW.site_id, NEW.type, NEW.survenu_le, NEW.lieu, NEW.service, NEW.description, NEW.salarie_id, NEW.victime_externe, NEW.arret_travail, NEW.jours_arret)
     IS DISTINCT FROM
     (OLD.site_id, OLD.type, OLD.survenu_le, OLD.lieu, OLD.service, OLD.description, OLD.salarie_id, OLD.victime_externe, OLD.arret_travail, OLD.jours_arret) THEN
    RAISE EXCEPTION 'Les faits d''une déclaration sont figés après qualification : ajoutez un commentaire à l''historique.' USING ERRCODE = 'IF409';
  END IF;

  IF NEW.statut IS DISTINCT FROM OLD.statut THEN
    IF NOT ((OLD.statut = 'a_qualifier' AND NEW.statut IN ('en_analyse', 'en_action', 'sans_suite'))
         OR (OLD.statut = 'en_analyse'  AND NEW.statut IN ('en_action', 'cloturee', 'sans_suite'))
         OR (OLD.statut = 'en_action'   AND NEW.statut IN ('en_analyse', 'cloturee'))) THEN
      RAISE EXCEPTION 'Transition de statut impossible : % → %.', OLD.statut, NEW.statut USING ERRCODE = 'IF409';
    END IF;
    IF NEW.statut = 'sans_suite' AND NULLIF(btrim(coalesce(NEW.motif_sans_suite, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Un motif est requis pour classer sans suite.' USING ERRCODE = 'IF409';
    END IF;
    IF NEW.statut <> 'sans_suite' AND (NEW.gravite IS NULL OR NEW.frequence IS NULL) THEN
      RAISE EXCEPTION 'Gravité et fréquence sont requises pour qualifier la déclaration.' USING ERRCODE = 'IF409';
    END IF;
    IF NEW.statut = 'cloturee' AND EXISTS (
         SELECT 1 FROM action_corrective a
         WHERE a.origine_type = 'declaration' AND a.origine_id = NEW.id AND a.statut IN ('a_faire', 'en_cours')) THEN
      RAISE EXCEPTION 'Des actions correctives restent ouvertes : clôture impossible.' USING ERRCODE = 'IF409';
    END IF;
    -- Qualification posée par le serveur, jamais par le client.
    IF OLD.statut = 'a_qualifier' THEN
      NEW.qualifie_par := v_uid;
      NEW.qualifie_le := now();
    END IF;
  ELSIF (NEW.qualifie_par, NEW.qualifie_le) IS DISTINCT FROM (OLD.qualifie_par, OLD.qualifie_le) THEN
    RAISE EXCEPTION 'Le qualifieur et la date de qualification sont posés par le serveur.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION proteger_declaration() FROM PUBLIC;

CREATE TRIGGER trg_declaration_figee BEFORE UPDATE ON declaration
  FOR EACH ROW EXECUTE FUNCTION proteger_declaration();

-- Historique des statuts tenu par la base : création et chaque changement de statut.
-- Sur une déclaration anonyme, la ligne de création ne porte aucun utilisateur.
CREATE OR REPLACE FUNCTION tracer_declaration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO historique_declaration (entreprise_id, declaration_id, utilisateur_id, statut_avant, statut_apres)
    VALUES (NEW.entreprise_id, NEW.id,
            CASE WHEN NEW.anonyme THEN NULL ELSE NULLIF(current_setting('app.utilisateur_id', true), '')::uuid END,
            NULL, NEW.statut);
  ELSIF NEW.statut IS DISTINCT FROM OLD.statut THEN
    INSERT INTO historique_declaration (entreprise_id, declaration_id, utilisateur_id, statut_avant, statut_apres)
    VALUES (NEW.entreprise_id, NEW.id, NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, OLD.statut, NEW.statut);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION tracer_declaration() FROM PUBLIC;

CREATE TRIGGER trg_declaration_historique AFTER INSERT OR UPDATE OF statut ON declaration
  FOR EACH ROW EXECUTE FUNCTION tracer_declaration();

-- Origine d'une action : non-conformité (B5, inchangé) OU déclaration de la même entreprise (B3).
CREATE OR REPLACE FUNCTION verifier_origine_action_inspection() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.origine_type = 'inspection' THEN
    IF NEW.origine_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM non_conformite nc
         WHERE nc.id = NEW.origine_id AND nc.entreprise_id = NEW.entreprise_id) THEN
      RAISE EXCEPTION
        'Une action corrective d''origine inspection doit référencer (origine_id) une non-conformité de la même entreprise.';
    END IF;
  ELSIF NEW.origine_type = 'declaration' THEN
    IF NEW.origine_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM declaration d
         WHERE d.id = NEW.origine_id AND d.entreprise_id = NEW.entreprise_id) THEN
      RAISE EXCEPTION
        'Une action corrective d''origine déclaration doit référencer (origine_id) une déclaration de la même entreprise.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Cohérence des actions d'origine « declaration » (les actions B5 gardent leurs règles).
CREATE OR REPLACE FUNCTION verifier_coherence_action_declaration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.origine_type <> 'declaration' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM declaration d WHERE d.id = NEW.origine_id AND d.statut IN ('cloturee', 'sans_suite')) THEN
    RAISE EXCEPTION 'Déclaration clôturée ou sans suite : aucune action ne peut s''y ajouter.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut IN ('realisee', 'verifiee') AND NEW.realisee_le IS NULL THEN
    RAISE EXCEPTION 'La date de réalisation est requise.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut = 'verifiee' AND (NEW.verifiee_par IS NULL OR NEW.verifiee_le IS NULL OR NEW.efficace IS NULL) THEN
    RAISE EXCEPTION 'La vérification d''efficacité (vérificateur, date, résultat) est requise.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut = 'abandonnee' AND NULLIF(btrim(coalesce(NEW.motif_abandon, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Un motif d''abandon est requis.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION verifier_coherence_action_declaration() FROM PUBLIC;

CREATE TRIGGER trg_action_coherence_declaration BEFORE INSERT OR UPDATE ON action_corrective
  FOR EACH ROW EXECUTE FUNCTION verifier_coherence_action_declaration();

-- Auteur d'une analyse posé par le serveur.
CREATE OR REPLACE FUNCTION poser_auteur_analyse() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.realisee_par := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
    NEW.realisee_le := coalesce(NEW.realisee_le, current_date);
  ELSE
    NEW.realisee_par := OLD.realisee_par;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_analyse_auteur BEFORE INSERT OR UPDATE ON analyse_cause
  FOR EACH ROW EXECUTE FUNCTION poser_auteur_analyse();
