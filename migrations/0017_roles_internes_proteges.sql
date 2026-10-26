-- =====================================================================
-- Comptes clients créés par le consultant (écran « Accès », 30/09/2026) :
-- garde-fou contre l'élévation de privilèges.
--
-- La RLS de role_utilisateur vérifie seulement que l'utilisateur appartient
-- au tenant courant ; rien n'empêchait, en base, d'attribuer à un compte
-- CLIENT le rôle consultant_ifecarm ou admin_plateforme (lequel contourne
-- ensuite des contrôles applicatifs). Ces deux rôles sont désormais réservés
-- aux utilisateurs d'une entreprise interne (IFECARM GROUP), quel que soit
-- le chemin d'écriture.
-- =====================================================================

CREATE OR REPLACE FUNCTION verifier_role_interne() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.role IN ('consultant_ifecarm', 'admin_plateforme') AND NOT EXISTS (
    SELECT 1 FROM utilisateur u JOIN entreprise e ON e.id = u.entreprise_id
    WHERE u.id = NEW.utilisateur_id AND e.interne
  ) THEN
    RAISE EXCEPTION 'Le rôle % est réservé aux utilisateurs IFECARM GROUP.', NEW.role;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION verifier_role_interne() FROM PUBLIC;

CREATE TRIGGER trg_role_interne
  BEFORE INSERT OR UPDATE ON role_utilisateur
  FOR EACH ROW EXECUTE FUNCTION verifier_role_interne();
