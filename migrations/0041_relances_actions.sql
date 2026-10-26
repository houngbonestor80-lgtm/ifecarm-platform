-- =====================================================================
-- B3 : relances automatiques des actions correctives (06/10/2026).
-- relance_action existait (0005) sans rien pour l'alimenter. Mécanisme choisi
-- avec l'utilisateur : une fonction SQL idempotente, lancée chaque jour par un
-- script (npm run relances : Planificateur de tâches Windows en local, cron en
-- production). Elle écrit la relance (relance_action) et met en file les
-- e-mails (notification, statut en_attente) ; l'envoi effectif viendra avec
-- le fournisseur d'e-mail, qui n'est pas encore choisi.
--
-- Jalons (une relance par action et par jalon, UNIQUE (action_id, jalon)) :
--   j_moins_7  échéance dans 1 à 7 jours
--   echeance   échéance atteinte ou dépassée de moins de 7 jours
--   j_plus_7   en retard de 7 à 29 jours
--   j_plus_30  en retard de 30 jours ou plus
-- Une seule relance par exécution et par action : le jalon le plus avancé
-- atteint (si la tâche n'a pas tourné pendant un mois, pas de rafale de quatre
-- e-mails). Les actions réalisées, vérifiées ou abandonnées, sans échéance, ou
-- d'une entreprise désactivée ou interne sont ignorées.
-- Destinataires : le compte responsable de l'action s'il existe, plus les
-- comptes admin_entreprise et responsable_qhse de l'entreprise (sans doublon).
-- SECURITY DEFINER : la fonction lit et écrit sur tous les tenants (c'est son
-- rôle) ; elle ne renvoie qu'un nombre. `p_entreprise` limite l'exécution à une
-- entreprise (tests, reprise).
-- =====================================================================

CREATE OR REPLACE FUNCTION relancer_actions_en_retard(p_entreprise uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action   record;
  v_dest     record;
  v_relance  uuid;
  v_premier  uuid;
  v_notif    uuid;
  v_jalon    text;
  v_ecart    integer;
  v_sujet    text;
  v_corps    text;
  v_module   text;
  v_nb       integer := 0;
BEGIN
  FOR v_action IN
    SELECT a.id, a.entreprise_id, a.reference, a.libelle, a.echeance, a.origine_type, a.responsable_id
    FROM action_corrective a
    JOIN entreprise e ON e.id = a.entreprise_id
    WHERE a.statut IN ('a_faire', 'en_cours')
      AND a.echeance IS NOT NULL
      AND a.echeance - current_date <= 7
      AND NOT e.interne AND e.desactive_le IS NULL
      AND (p_entreprise IS NULL OR a.entreprise_id = p_entreprise)
    ORDER BY a.entreprise_id, a.echeance, a.id
  LOOP
    v_ecart := current_date - v_action.echeance;   -- jours de retard ; négatif = à venir
    v_jalon := CASE WHEN v_ecart >= 30 THEN 'j_plus_30'
                    WHEN v_ecart >= 7  THEN 'j_plus_7'
                    WHEN v_ecart >= 0  THEN 'echeance'
                    ELSE 'j_moins_7' END;

    -- Idempotence et exécutions concurrentes : la contrainte UNIQUE tranche.
    INSERT INTO relance_action (entreprise_id, action_id, jalon)
    VALUES (v_action.entreprise_id, v_action.id, v_jalon)
    ON CONFLICT (action_id, jalon) DO NOTHING
    RETURNING id INTO v_relance;
    CONTINUE WHEN v_relance IS NULL;

    v_module := CASE v_action.origine_type WHEN 'declaration' THEN 'registre' WHEN 'inspection' THEN 'inspections' ELSE 'actions' END;
    IF v_ecart < 0 THEN
      v_sujet := 'Action à réaliser avant le ' || to_char(v_action.echeance, 'DD/MM/YYYY') || ' — ' || v_action.reference;
      v_corps := 'L''action ' || v_action.reference || ' « ' || v_action.libelle || ' » arrive à échéance le '
                 || to_char(v_action.echeance, 'DD/MM/YYYY') || '.';
    ELSE
      v_sujet := 'Action en retard — ' || v_action.reference;
      v_corps := 'L''action ' || v_action.reference || ' « ' || v_action.libelle || ' » était attendue le '
                 || to_char(v_action.echeance, 'DD/MM/YYYY') || ' (retard de ' || v_ecart || ' jour' || CASE WHEN v_ecart > 1 THEN 's' ELSE '' END || ').';
    END IF;

    v_premier := NULL;
    FOR v_dest IN
      SELECT DISTINCT lower(u.email::text) AS email
      FROM utilisateur u
      WHERE u.actif AND u.entreprise_id = v_action.entreprise_id
        AND (u.id = v_action.responsable_id
             OR EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role IN ('admin_entreprise', 'responsable_qhse')))
      ORDER BY 1
    LOOP
      INSERT INTO notification (entreprise_id, canal, destinataire, sujet, corps, module)
      VALUES (v_action.entreprise_id, 'email', v_dest.email, v_sujet, v_corps, v_module)
      RETURNING id INTO v_notif;
      v_premier := coalesce(v_premier, v_notif);
    END LOOP;

    UPDATE relance_action SET notification_id = v_premier WHERE id = v_relance;
    v_nb := v_nb + 1;
  END LOOP;
  RETURN v_nb;
END;
$$;

REVOKE EXECUTE ON FUNCTION relancer_actions_en_retard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relancer_actions_en_retard(uuid) TO ifecarm_app;
