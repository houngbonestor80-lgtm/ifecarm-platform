-- =====================================================================
-- Suppression DÉFINITIVE d'un prospect ou d'un client — demande du
-- 30/09/2026 (effacer les essais avant la mise en service réelle).
-- Revient sur l'arbitrage du 28/09 (0010 : « désactiver, jamais supprimer »)
-- à la demande explicite du client, avec ces garde-fous :
--
--   * Qui : un prospect — consultant avec accès valide EN ÉCRITURE, ou
--     admin_plateforme ; un client — admin_plateforme uniquement.
--     Jamais une entreprise interne (IFECARM GROUP).
--   * Confirmation : le nom exact de l'entreprise doit être ressaisi.
--   * Journal d'audit : ses lignes ne sont JAMAIS effacées. Seul changement
--     toléré par journal_immuable() : les références entreprise_id /
--     utilisateur_id passent à NULL (ON DELETE SET NULL), tout le reste
--     identique. La suppression elle-même est journalisée (nom, statut).
--   * Tout passe par supprimer_entreprise() (SECURITY DEFINER) : ifecarm_app
--     n'obtient aucun droit DELETE sur entreprise.
-- =====================================================================

CREATE OR REPLACE FUNCTION journal_immuable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.entreprise_id IS NULL OR NEW.entreprise_id = OLD.entreprise_id)
     AND (NEW.utilisateur_id IS NULL OR NEW.utilisateur_id = OLD.utilisateur_id)
     AND (NEW.id, NEW.action, NEW.objet_type, NEW.objet_id, NEW.details, NEW.adresse_ip, NEW.cree_le)
         IS NOT DISTINCT FROM (OLD.id, OLD.action, OLD.objet_type, OLD.objet_id, OLD.details, OLD.adresse_ip, OLD.cree_le)
  THEN
    RETURN NEW;  -- détachement d'une entité supprimée : la ligne reste
  END IF;
  RAISE EXCEPTION 'Le journal d''audit ne peut être ni modifié ni supprimé.';
END;
$$ LANGUAGE plpgsql;

-- Inspections : pendant la suppression d'une entreprise (marquée désactivée
-- juste avant par supprimer_entreprise), ses inspections partent avec elle.
-- Une entreprise désactivée n'est plus atteignable par l'application
-- (avecTenant), ce relâchement ne sert donc qu'à la suppression.
CREATE OR REPLACE FUNCTION empecher_suppression_inspection_probante() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entreprise e WHERE e.id = OLD.entreprise_id AND e.desactive_le IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  IF OLD.statut NOT IN ('brouillon', 'en_cours', 'annulee') THEN
    RAISE EXCEPTION 'Inspection % : une inspection clôturée doit d''abord être rangée (annulée) avant suppression (statut actuel : %).', OLD.id, OLD.statut;
  END IF;
  IF EXISTS (SELECT 1 FROM non_conformite nc WHERE nc.inspection_id = OLD.id) THEN
    RAISE EXCEPTION 'Inspection % : elle comporte des non-conformités, elle doit être annulée et non supprimée.', OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

-- Renvoie les clés de stockage des fichiers de l'entreprise (nettoyage S3 côté appli).
-- Codes d'erreur : IF403 (droit), IF404 (introuvable), IF409 (confirmation).
CREATE OR REPLACE FUNCTION supprimer_entreprise(p_id uuid, p_confirmation text) RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_e entreprise%ROWTYPE;
  v_admin boolean;
  v_ecriture boolean;
  v_cles text[];
BEGIN
  SELECT * INTO v_e FROM entreprise WHERE id = p_id;
  IF NOT FOUND OR v_e.interne THEN
    RAISE EXCEPTION 'Entreprise introuvable.' USING ERRCODE = 'IF404';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = v_uid AND r.role = 'admin_plateforme' AND u.actif AND e.interne
  ) INTO v_admin;
  SELECT EXISTS (
    SELECT 1 FROM acces_consultant a
    JOIN role_utilisateur r ON r.utilisateur_id = a.utilisateur_id AND r.role IN ('consultant_ifecarm', 'admin_plateforme')
    JOIN utilisateur u ON u.id = a.utilisateur_id
    WHERE a.utilisateur_id = v_uid AND a.entreprise_id = p_id AND a.ecriture AND u.actif
      AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE)
  ) INTO v_ecriture;

  IF NOT v_admin AND NOT (v_e.statut_relation = 'prospect' AND v_ecriture) THEN
    RAISE EXCEPTION '%', CASE WHEN v_e.statut_relation = 'client'
      THEN 'Seul l''administrateur de la plateforme peut supprimer un client.'
      ELSE 'Accès en écriture à ce prospect requis pour le supprimer.' END
      USING ERRCODE = 'IF403';
  END IF;
  IF p_confirmation IS NULL OR lower(btrim(p_confirmation)) <> lower(btrim(v_e.nom)) THEN
    RAISE EXCEPTION 'Le nom saisi ne correspond pas à celui de l''entreprise.' USING ERRCODE = 'IF409';
  END IF;

  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (v_uid, NULL, 'suppression', 'entreprise', p_id,
          jsonb_build_object('nom', v_e.nom, 'statut_relation', v_e.statut_relation, 'pays', v_e.pays));

  SELECT coalesce(array_agg(cle_stockage), '{}') INTO v_cles FROM fichier WHERE entreprise_id = p_id;

  -- Coupe l'accès immédiatement et autorise l'effacement des inspections.
  UPDATE entreprise SET desactive_le = coalesce(desactive_le, now()) WHERE id = p_id;

  -- Clés étrangères ON DELETE RESTRICT internes à l'entreprise : on efface
  -- d'abord les lignes qui référencent, puis l'entreprise emporte le reste.
  DELETE FROM action_corrective WHERE entreprise_id = p_id;
  DELETE FROM non_conformite WHERE entreprise_id = p_id;
  DELETE FROM inspection WHERE entreprise_id = p_id;
  DELETE FROM attestation WHERE entreprise_id = p_id;
  DELETE FROM participant WHERE entreprise_id = p_id;
  DELETE FROM session_formation WHERE entreprise_id = p_id;
  DELETE FROM entreprise WHERE id = p_id;

  RETURN v_cles;
END;
$$;

REVOKE EXECUTE ON FUNCTION supprimer_entreprise(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supprimer_entreprise(uuid, text) TO ifecarm_app;
