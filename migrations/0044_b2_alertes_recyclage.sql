-- =====================================================================
-- B2 : alertes de recyclage des attestations de formation (07/10/2026).
-- La table alerte_recyclage existait (0004) sans rien pour l'alimenter.
-- Même mécanisme que les relances B3 (0041) et les alertes B4 (0043) : une
-- fonction SQL idempotente, lancée chaque jour par `npm run relances` ; les
-- e-mails sont mis en file (notification, en_attente), l'envoi est assuré par
-- le même script.
--
-- CONVENTION DE B2 CONSERVÉE : jalons 90, 30 et 7 jours (contrainte de 0004),
-- SANS jalon « échéance » (contrairement à B4). Une attestation déjà échue et
-- jamais signalée déclenche le jalon 7, avec un message « échue ».
-- Une alerte par attestation et par exécution : le jalon le plus avancé
-- atteint (pas de rafale si la tâche n'a pas tourné pendant un mois).
--
-- Ignorées : attestations annulées ou sans échéance, salariés sortis ou hors
-- effectif, entreprises désactivées ou internes, et attestations DÉJÀ
-- renouvelées (le même salarié détient une autre attestation valide de la même
-- formation, dont l'échéance est plus lointaine ou absente).
-- Destinataires : admin d'entreprise, responsable QHSE et responsable du site du
-- salarié, sans doublon.
-- =====================================================================

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
    v_jalon := CASE WHEN v_reste <= 7 THEN 7 WHEN v_reste <= 30 THEN 30 ELSE 90 END;

    INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours)
    VALUES (v_a.entreprise_id, v_a.id, v_jalon)
    ON CONFLICT (attestation_id, jalon_jours) DO NOTHING
    RETURNING id INTO v_alerte;
    CONTINUE WHEN v_alerte IS NULL;

    IF v_reste >= 0 THEN
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
