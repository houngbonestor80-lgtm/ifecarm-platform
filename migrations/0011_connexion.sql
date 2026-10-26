-- =====================================================================
-- Connexion : unicité de l'email et fonctions de recherche avant tenant.
--
-- Décision actée (arbitrage du 28/09/2026) : l'email d'un utilisateur actif est
-- GLOBALEMENT unique. Un utilisateur est une personne avec une entreprise de
-- rattachement ; l'accès à d'autres tenants passe par acces_consultant, pas par
-- une seconde ligne utilisateur sous la même adresse chez un autre client. Sans
-- cette règle, « email + mot de passe » serait ambigu (quelle entreprise ?).
--
-- Pourquoi des fonctions SECURITY DEFINER : à la connexion, aucun tenant n'est
-- encore choisi, or utilisateur et entreprise sont protégés par la RLS sur
-- entreprise_id — ifecarm_app n'y verrait aucune ligne. Même patron que
-- verifier_attestation : search_path fixé, EXECUTE retiré à PUBLIC, et seulement
-- les colonnes indispensables en sortie.
-- =====================================================================

-- Garde-fou : échoue avec un message explicite si des doublons existent déjà.
DO $$
DECLARE
  nb integer;
BEGIN
  SELECT count(*) INTO nb FROM (
    SELECT email FROM utilisateur WHERE actif GROUP BY email HAVING count(*) > 1
  ) d;
  IF nb > 0 THEN
    RAISE EXCEPTION
      '% adresse(s) email portée(s) par plusieurs utilisateurs actifs : à dédoublonner avant d''appliquer 0011.', nb;
  END IF;
END
$$;

-- citext : l'unicité ignore la casse. Partielle : un compte désactivé libère
-- son adresse.
CREATE UNIQUE INDEX utilisateur_email_actif_unique ON utilisateur (email) WHERE actif;

-- Recherche pour l'authentification. Ne renvoie QUE ce dont la connexion a
-- besoin, et rien pour un compte inactif ou dont l'entreprise est désactivée.
-- Le hash est renvoyé parce que la vérification argon2id se fait côté
-- application (elle est impossible en SQL) ; il ne quitte jamais la couche
-- src/auth/connexion.ts.
CREATE OR REPLACE FUNCTION rechercher_utilisateur_connexion(p_email citext)
RETURNS TABLE (
  utilisateur_id uuid,
  entreprise_id uuid,
  mot_de_passe_hash text,
  totp_actif boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.entreprise_id, u.mot_de_passe_hash, u.totp_actif
  FROM utilisateur u
  JOIN entreprise e ON e.id = u.entreprise_id
  WHERE u.email = p_email
    AND u.actif
    AND e.desactive_le IS NULL;
$$;

-- Entreprises (clientes ou prospects) où le consultant APPELANT a un accès
-- valide, avec leur nom : le sélecteur en a besoin avant que le tenant soit
-- choisi, moment où entreprise n'est pas lisible. Ne concerne que l'appelant
-- (app.utilisateur_id), jamais un autre utilisateur.
CREATE OR REPLACE FUNCTION lister_entreprises_consultant()
RETURNS TABLE (
  entreprise_id uuid,
  nom text,
  statut_relation text,
  ecriture boolean,
  fin_le date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.nom, e.statut_relation, a.ecriture, a.fin_le
  FROM acces_consultant a
  JOIN entreprise e ON e.id = a.entreprise_id
  WHERE a.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)
    AND e.desactive_le IS NULL
  ORDER BY e.nom;
$$;

REVOKE EXECUTE ON FUNCTION rechercher_utilisateur_connexion(citext) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lister_entreprises_consultant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rechercher_utilisateur_connexion(citext) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION lister_entreprises_consultant() TO ifecarm_app;
