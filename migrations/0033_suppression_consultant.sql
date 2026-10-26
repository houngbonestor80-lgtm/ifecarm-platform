-- =====================================================================
-- Suppression définitive d'un compte consultant (05/10/2026), réservée à
-- l'administrateur. ifecarm_app n'a pas de DELETE sur utilisateur : tout passe
-- par cette fonction SECURITY DEFINER (même schéma que supprimer_entreprise,
-- 0015). Garde-fous : administrateur uniquement, cible = consultant interne
-- qui n'est pas aussi administrateur, jamais soi-même, email à ressaisir.
-- Effets (clés étrangères déjà en place) : accès, sessions de connexion et
-- jetons disparaissent (déconnexion immédiate) ; inspections, notes de suivi,
-- sessions de formation, fichiers et plans d'action qui le citaient sont
-- conservés, avec la référence au compte mise à NULL (les noms figés dans
-- les rapports et notes restent) ; le journal d'audit n'est jamais effacé.
-- Codes d'erreur : IF403 (droit), IF404 (introuvable), IF409 (confirmation, soi-même).
-- =====================================================================

CREATE OR REPLACE FUNCTION supprimer_compte_consultant(p_id uuid, p_email text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_email text;
BEGIN
  IF NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur.' USING ERRCODE = 'IF403';
  END IF;

  SELECT u.email::text INTO v_email
  FROM utilisateur u
  JOIN entreprise e ON e.id = u.entreprise_id AND e.interne
  WHERE u.id = p_id
    AND EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role = 'consultant_ifecarm')
    AND NOT EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role = 'admin_plateforme');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consultant introuvable.' USING ERRCODE = 'IF404';
  END IF;
  IF p_id = v_uid THEN
    RAISE EXCEPTION 'Vous ne pouvez pas supprimer votre propre compte.' USING ERRCODE = 'IF409';
  END IF;
  IF lower(btrim(coalesce(p_email, ''))) <> lower(v_email) THEN
    RAISE EXCEPTION 'Confirmation incorrecte : ressaisissez l''email du consultant.' USING ERRCODE = 'IF409';
  END IF;

  DELETE FROM utilisateur WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION supprimer_compte_consultant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supprimer_compte_consultant(uuid, text) TO ifecarm_app;
