-- =====================================================================
-- Conversion d'un prospect en client (30/09/2026), réservée à
-- l'administrateur : l'entreprise garde tout son historique (inspections,
-- non-conformités, plans d'action, comptes, équipements) et ne change que
-- de statut. Les modules réservés aux clients pourront ensuite lui être
-- ouverts (le déclencheur de 0008 les refusait tant qu'elle était prospect).
--
-- Codes d'erreur : IF403 (droit), IF404 (introuvable), IF409 (déjà client).
-- =====================================================================

CREATE OR REPLACE FUNCTION convertir_prospect_en_client(p_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_e entreprise%ROWTYPE;
BEGIN
  IF NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  SELECT * INTO v_e FROM entreprise WHERE id = p_id AND NOT interne AND desactive_le IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entreprise introuvable.' USING ERRCODE = 'IF404';
  END IF;
  IF v_e.statut_relation = 'client' THEN
    RAISE EXCEPTION 'Cette entreprise est déjà cliente.' USING ERRCODE = 'IF409';
  END IF;

  UPDATE entreprise SET statut_relation = 'client' WHERE id = p_id;

  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, p_id, 'conversion_client', 'entreprise', p_id,
          jsonb_build_object('nom', v_e.nom, 'de', 'prospect', 'vers', 'client'));
END;
$$;

REVOKE EXECUTE ON FUNCTION convertir_prospect_en_client(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION convertir_prospect_en_client(uuid) TO ifecarm_app;
