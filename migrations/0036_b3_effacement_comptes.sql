-- =====================================================================
-- Correctif de 0035 (révélé par les tests) : la suppression d'un compte
-- (supprimer_compte_consultant 0033, suppression d'entreprise, etc.) met à
-- NULL les références utilisateur du registre (ON DELETE SET NULL). Les
-- déclencheurs de 0035 bloquaient ces mises à jour :
--   - proteger_declaration : déclaration figée / déclarant ne change jamais ;
--   - verifier_coherence_action_declaration : « vérifiée » sans vérificateur ;
--   - poser_auteur_analyse : remettait l'auteur d'origine, donc la clé
--     étrangère empêchait la suppression du compte.
-- Règle : une mise à jour qui ne fait QUE retirer une référence utilisateur
-- (valeur → NULL, rien d'autre ne change) est toujours permise. Tout le reste
-- garde les protections de 0035.
-- =====================================================================

CREATE OR REPLACE FUNCTION proteger_declaration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  -- Effacement d'un compte : seule une référence utilisateur passe à NULL.
  IF (to_jsonb(NEW) - 'declarant_id' - 'qualifie_par' - 'modifie_le' - 'criticite')
       = (to_jsonb(OLD) - 'declarant_id' - 'qualifie_par' - 'modifie_le' - 'criticite')
     AND (NEW.declarant_id IS NULL OR NEW.declarant_id IS NOT DISTINCT FROM OLD.declarant_id)
     AND (NEW.qualifie_par IS NULL OR NEW.qualifie_par IS NOT DISTINCT FROM OLD.qualifie_par) THEN
    RETURN NEW;
  END IF;

  IF OLD.statut IN ('cloturee', 'sans_suite') THEN
    RAISE EXCEPTION 'Une déclaration clôturée ou classée sans suite est figée.' USING ERRCODE = 'IF409';
  END IF;

  IF (NEW.id, NEW.entreprise_id, NEW.reference, NEW.cle_client, NEW.anonyme, NEW.declarant_id, NEW.saisi_hors_ligne, NEW.cree_le)
     IS DISTINCT FROM
     (OLD.id, OLD.entreprise_id, OLD.reference, OLD.cle_client, OLD.anonyme, OLD.declarant_id, OLD.saisi_hors_ligne, OLD.cree_le) THEN
    RAISE EXCEPTION 'L''identité, la référence, l''anonymat et le déclarant d''une déclaration ne changent jamais.' USING ERRCODE = 'IF409';
  END IF;

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

CREATE OR REPLACE FUNCTION verifier_coherence_action_declaration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.origine_type <> 'declaration' THEN RETURN NEW; END IF;
  -- Effacement d'un compte : seules des références utilisateur passent à NULL.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'responsable_id' - 'verifiee_par' - 'modifie_le') = (to_jsonb(OLD) - 'responsable_id' - 'verifiee_par' - 'modifie_le')
     AND (NEW.responsable_id IS NULL OR NEW.responsable_id IS NOT DISTINCT FROM OLD.responsable_id)
     AND (NEW.verifiee_par IS NULL OR NEW.verifiee_par IS NOT DISTINCT FROM OLD.verifiee_par) THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION poser_auteur_analyse() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.realisee_par := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
    NEW.realisee_le := coalesce(NEW.realisee_le, current_date);
  ELSIF NEW.realisee_par IS NOT NULL THEN
    NEW.realisee_par := OLD.realisee_par;  -- l'auteur ne change pas ; seul son effacement (NULL) passe
  END IF;
  RETURN NEW;
END;
$$;
