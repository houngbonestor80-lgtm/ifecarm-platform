-- =====================================================================
-- Suppression des inspections — règle « mixte » (arbitrage du 29/09/2026).
--
-- * Suppression DÉFINITIVE autorisée uniquement pour une inspection non
--   clôturée (brouillon, en_cours) SANS non-conformité : erreur de saisie,
--   inspection créée par erreur. Rien de probant n'est alors perdu.
-- * Sinon (clôturée, ou avec au moins une NC) : l'application ANNULE
--   l'inspection (statut 'annulee') ; elle reste en base pour la traçabilité.
--
-- Le garde-fou ci-dessous applique la règle en base : même un bug applicatif
-- ne peut pas effacer une inspection clôturée ou porteuse de NC (dont les
-- plans d'action, liés sans clé étrangère via origine_id, deviendraient
-- orphelins). Les points de contrôle et rapports suivent par ON DELETE CASCADE.
-- =====================================================================

CREATE OR REPLACE FUNCTION empecher_suppression_inspection_probante() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.statut NOT IN ('brouillon', 'en_cours') THEN
    RAISE EXCEPTION 'Inspection % : seule une inspection non clôturée peut être supprimée (statut actuel : %).', OLD.id, OLD.statut;
  END IF;
  IF EXISTS (SELECT 1 FROM non_conformite nc WHERE nc.inspection_id = OLD.id) THEN
    RAISE EXCEPTION 'Inspection % : elle comporte des non-conformités, elle doit être annulée et non supprimée.', OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION empecher_suppression_inspection_probante() FROM PUBLIC;

CREATE TRIGGER trg_suppression_inspection_probante
  BEFORE DELETE ON inspection
  FOR EACH ROW EXECUTE FUNCTION empecher_suppression_inspection_probante();

-- La politique RLS cloisonnement_inspection (FOR ALL) couvre déjà DELETE.
GRANT DELETE ON inspection TO ifecarm_app;
