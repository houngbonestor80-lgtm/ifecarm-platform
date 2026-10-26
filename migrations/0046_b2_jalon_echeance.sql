-- =====================================================================
-- B2 : jalon « échéance » pour les alertes de recyclage (07/10/2026).
-- Décision de l'utilisateur : mêmes jalons que B3 (0041) et B4 (0043) — 90, 30,
-- 7 jours puis échéance (jalon 0) — pour un seul mécanisme sur toute la
-- plateforme. Remplace la convention « sans jalon échéance » de 0044.
-- Le jalon 0 se déclenche le jour de l'échéance ou après (attestation échue) ;
-- une attestation déjà signalée au jalon 7 reçoit donc une dernière alerte à
-- l'échéance. Toujours le jalon le plus avancé, une seule fois par attestation.
-- =====================================================================

DO $$
DECLARE v_nom text;
BEGIN
  SELECT conname INTO v_nom FROM pg_constraint
   WHERE conrelid = 'alerte_recyclage'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%jalon_jours%';
  IF v_nom IS NOT NULL THEN EXECUTE format('ALTER TABLE alerte_recyclage DROP CONSTRAINT %I', v_nom); END IF;
END $$;
ALTER TABLE alerte_recyclage ADD CONSTRAINT alerte_recyclage_jalon_jours_check CHECK (jalon_jours IN (90, 30, 7, 0));

CREATE OR REPLACE FUNCTION alerter_recyclages(p_entreprise uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_a record;
  v_dest record;
  v_alerte uuid;
  v_premier uuid;
  v_notif uuid;
  v_jalon integer;
  v_reste integer;
  v_sujet text;
  v_corps text;
  v_nb integer := 0;
BEGIN
  FOR v_a IN
    SELECT a.id, a.entreprise_id, a.expire_le, a.intitule_formation, a.prenom_salarie, a.nom_salarie, s.site_id
    FROM attestation a
    JOIN participant p ON p.id = a.participant_id
    JOIN session_formation sf ON sf.id = p.session_id
    JOIN salarie s ON s.id = p.salarie_id
    JOIN entreprise e ON e.id = a.entreprise_id
    WHERE a.statut = 'valide' AND a.expire_le IS NOT NULL
      AND a.expire_le - current_date <= 90
      AND s.actif AND (s.date_sortie IS NULL OR s.date_sortie >= current_date)
      AND NOT e.interne AND e.desactive_le IS NULL
      AND (p_entreprise IS NULL OR a.entreprise_id = p_entreprise)
      AND NOT EXISTS (
        SELECT 1 FROM attestation a2
        JOIN participant p2 ON p2.id = a2.participant_id
        JOIN session_formation sf2 ON sf2.id = p2.session_id
        WHERE a2.id <> a.id AND a2.statut = 'valide' AND p2.salarie_id = p.salarie_id
          AND sf2.formation_id = sf.formation_id
          AND (a2.expire_le IS NULL OR a2.expire_le > a.expire_le))
    ORDER BY a.entreprise_id, a.expire_le, a.id
  LOOP
    v_reste := v_a.expire_le - current_date;
    v_jalon := CASE WHEN v_reste <= 0 THEN 0 WHEN v_reste <= 7 THEN 7 WHEN v_reste <= 30 THEN 30 ELSE 90 END;

    INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours)
    VALUES (v_a.entreprise_id, v_a.id, v_jalon)
    ON CONFLICT (attestation_id, jalon_jours) DO NOTHING
    RETURNING id INTO v_alerte;
    CONTINUE WHEN v_alerte IS NULL;

    IF v_reste = 0 THEN
      v_sujet := 'Attestation échue aujourd''hui — ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie;
      v_corps := 'L''attestation « ' || v_a.intitule_formation || ' » de ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie
                 || ' arrive à échéance aujourd''hui (' || to_char(v_a.expire_le, 'DD/MM/YYYY') || ').';
    ELSIF v_reste > 0 THEN
      v_sujet := 'Recyclage à prévoir — ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie;
      v_corps := 'L''attestation « ' || v_a.intitule_formation || ' » de ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie
                 || ' arrive à échéance le ' || to_char(v_a.expire_le, 'DD/MM/YYYY') || ' (dans ' || v_reste || ' jour' || CASE WHEN v_reste > 1 THEN 's' ELSE '' END || ').';
    ELSE
      v_sujet := 'Attestation échue — ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie;
      v_corps := 'L''attestation « ' || v_a.intitule_formation || ' » de ' || v_a.prenom_salarie || ' ' || v_a.nom_salarie
                 || ' est échue depuis le ' || to_char(v_a.expire_le, 'DD/MM/YYYY') || '.';
    END IF;

    v_premier := NULL;
    FOR v_dest IN
      SELECT DISTINCT lower(u.email::text) AS email
      FROM utilisateur u
      WHERE u.actif AND u.entreprise_id = v_a.entreprise_id
        AND (EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role IN ('admin_entreprise', 'responsable_qhse'))
             OR (v_a.site_id IS NOT NULL AND EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role = 'responsable_site' AND r.site_id = v_a.site_id)))
      ORDER BY 1
    LOOP
      INSERT INTO notification (entreprise_id, canal, destinataire, sujet, corps, module)
      VALUES (v_a.entreprise_id, 'email', v_dest.email, v_sujet, v_corps, 'formations')
      RETURNING id INTO v_notif;
      v_premier := coalesce(v_premier, v_notif);
    END LOOP;

    UPDATE alerte_recyclage SET notification_id = v_premier WHERE id = v_alerte;
    v_nb := v_nb + 1;
  END LOOP;
  RETURN v_nb;
END;
$$;

REVOKE EXECUTE ON FUNCTION alerter_recyclages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerter_recyclages(uuid) TO ifecarm_app;
