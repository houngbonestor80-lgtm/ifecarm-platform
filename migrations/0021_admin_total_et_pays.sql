-- =====================================================================
-- 1. L'administrateur (admin_plateforme) a accès à TOUT (30/09/2026) :
--    toute entreprise cliente ou prospect active, en écriture, sans mandat
--    à lui accorder. Le consultant, lui, reste limité à ses mandats.
--    Les fonctions ci-dessous sont SECURITY DEFINER : elles ne renvoient
--    qu'un booléen ou la liste des entreprises, et se basent sur
--    l'utilisateur de la session (app.utilisateur_id).
-- 2. Pays d'intervention : liste gérée en base (au lieu d'une liste figée
--    dans l'écran). Tout consultant ou administrateur peut AJOUTER un pays ;
--    seul l'administrateur peut le renommer, l'archiver ou le supprimer.
-- =====================================================================

CREATE OR REPLACE FUNCTION est_admin_plateforme_courant() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
      AND r.role = 'admin_plateforme' AND u.actif AND e.interne)
$$;

CREATE OR REPLACE FUNCTION est_consultant_ou_admin_courant() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
      AND r.role IN ('admin_plateforme', 'consultant_ifecarm') AND u.actif AND e.interne)
$$;

-- Entreprise (non interne, non désactivée) où l'administrateur de la session peut entrer.
CREATE OR REPLACE FUNCTION entreprise_accessible_admin(p_entreprise_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT est_admin_plateforme_courant()
     AND EXISTS (SELECT 1 FROM entreprise e WHERE e.id = p_entreprise_id AND NOT e.interne AND e.desactive_le IS NULL)
$$;

-- Sélecteur d'entreprises : l'administrateur les voit toutes, le consultant ses mandats.
CREATE OR REPLACE FUNCTION lister_entreprises_consultant()
RETURNS TABLE (entreprise_id uuid, nom text, statut_relation text, ecriture boolean, fin_le date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.nom, e.statut_relation, true, NULL::date
  FROM entreprise e
  WHERE est_admin_plateforme_courant() AND NOT e.interne AND e.desactive_le IS NULL
  UNION ALL
  SELECT e.id, e.nom, e.statut_relation, a.ecriture, a.fin_le
  FROM acces_consultant a
  JOIN entreprise e ON e.id = a.entreprise_id
  WHERE NOT est_admin_plateforme_courant()
    AND a.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)
    AND e.desactive_le IS NULL
  ORDER BY 2;
$$;

REVOKE EXECUTE ON FUNCTION est_admin_plateforme_courant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION est_consultant_ou_admin_courant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION entreprise_accessible_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION est_admin_plateforme_courant() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION est_consultant_ou_admin_courant() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION entreprise_accessible_admin(uuid) TO ifecarm_app;

-- ---------------------------------------------------------------------
-- Pays d'intervention
-- ---------------------------------------------------------------------

CREATE TABLE pays_intervention (
  code    text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  nom     text NOT NULL UNIQUE CHECK (char_length(nom) BETWEEN 1 AND 100),
  actif   boolean NOT NULL DEFAULT true,
  cree_le timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pays_intervention (code, nom) VALUES
  ('BJ', 'Bénin'), ('CI', 'Côte d''Ivoire'), ('TG', 'Togo'), ('FR', 'France');

-- Lecture seule pour l'application : toute écriture passe par les fonctions.
GRANT SELECT ON pays_intervention TO ifecarm_app;

-- Codes d'erreur : IF403 (droit), IF404 (introuvable), IF409 (invalide / existe déjà / utilisé).
CREATE OR REPLACE FUNCTION creer_pays_intervention(p_code text, p_nom text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_code text := upper(btrim(p_code));
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé aux consultants et administrateurs IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF v_code !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Code pays : 2 lettres (norme ISO, ex. SN pour le Sénégal).' USING ERRCODE = 'IF409';
  END IF;
  IF p_nom IS NULL OR btrim(p_nom) = '' OR char_length(btrim(p_nom)) > 100 THEN
    RAISE EXCEPTION 'Nom du pays requis (100 caractères maximum).' USING ERRCODE = 'IF409';
  END IF;
  IF EXISTS (SELECT 1 FROM pays_intervention WHERE code = v_code OR lower(nom) = lower(btrim(p_nom))) THEN
    RAISE EXCEPTION 'Ce pays existe déjà dans la liste.' USING ERRCODE = 'IF409';
  END IF;
  INSERT INTO pays_intervention (code, nom) VALUES (v_code, btrim(p_nom));
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, details)
  VALUES (NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, NULL, 'creation', 'pays_intervention',
          jsonb_build_object('code', v_code, 'nom', btrim(p_nom)));
END;
$$;

CREATE OR REPLACE FUNCTION modifier_pays_intervention(p_code text, p_nom text, p_actif boolean) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF p_nom IS NULL OR btrim(p_nom) = '' OR char_length(btrim(p_nom)) > 100 THEN
    RAISE EXCEPTION 'Nom du pays requis (100 caractères maximum).' USING ERRCODE = 'IF409';
  END IF;
  IF EXISTS (SELECT 1 FROM pays_intervention WHERE lower(nom) = lower(btrim(p_nom)) AND code <> p_code) THEN
    RAISE EXCEPTION 'Un autre pays porte déjà ce nom.' USING ERRCODE = 'IF409';
  END IF;
  UPDATE pays_intervention SET nom = btrim(p_nom), actif = p_actif WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pays introuvable.' USING ERRCODE = 'IF404'; END IF;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, details)
  VALUES (NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, NULL, 'modification', 'pays_intervention',
          jsonb_build_object('code', p_code, 'nom', btrim(p_nom), 'actif', p_actif));
END;
$$;

CREATE OR REPLACE FUNCTION supprimer_pays_intervention(p_code text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF EXISTS (SELECT 1 FROM entreprise WHERE pays = p_code) THEN
    RAISE EXCEPTION 'Des clients ou prospects sont rattachés à ce pays : archivez-le plutôt que de le supprimer.' USING ERRCODE = 'IF409';
  END IF;
  DELETE FROM pays_intervention WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pays introuvable.' USING ERRCODE = 'IF404'; END IF;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, details)
  VALUES (NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, NULL, 'suppression', 'pays_intervention',
          jsonb_build_object('code', p_code));
END;
$$;

REVOKE EXECUTE ON FUNCTION creer_pays_intervention(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION modifier_pays_intervention(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION supprimer_pays_intervention(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creer_pays_intervention(text, text) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION modifier_pays_intervention(text, text, boolean) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION supprimer_pays_intervention(text) TO ifecarm_app;
