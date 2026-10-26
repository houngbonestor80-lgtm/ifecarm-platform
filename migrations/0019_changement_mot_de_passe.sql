-- =====================================================================
-- Changement de son propre mot de passe (écran « Mon compte », 30/09/2026) :
-- le mot de passe provisoire remis par le consultant doit pouvoir être
-- remplacé par la personne elle-même.
--
-- SECURITY DEFINER : la ligne d'un consultant n'est pas visible (RLS) depuis
-- le tenant client où il travaille. Les deux fonctions ne portent QUE sur
-- l'utilisateur de la session (app.utilisateur_id), jamais sur un autre ;
-- le changement est journalisé par la fonction elle-même.
-- =====================================================================

CREATE OR REPLACE FUNCTION hash_mot_de_passe_courant() RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT mot_de_passe_hash FROM utilisateur
  WHERE id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid AND actif
$$;

CREATE OR REPLACE FUNCTION definir_mot_de_passe_courant(p_hash text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_hash IS NULL OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'Hash de mot de passe invalide.';
  END IF;
  UPDATE utilisateur SET mot_de_passe_hash = p_hash
  WHERE id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid AND actif;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Utilisateur de la session introuvable.';
  END IF;
  -- Trace rattachée à l'entreprise de la personne (la RLS du journal
  -- l'exigerait depuis l'application, où le tenant peut être un client).
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id)
  SELECT u.id, u.entreprise_id, 'changement_mot_de_passe', 'utilisateur', u.id
  FROM utilisateur u WHERE u.id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION hash_mot_de_passe_courant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION definir_mot_de_passe_courant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hash_mot_de_passe_courant() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION definir_mot_de_passe_courant(text) TO ifecarm_app;
