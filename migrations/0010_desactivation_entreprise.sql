-- =====================================================================
-- Désactivation d'une entreprise (prospect abandonné) — pas de suppression.
--
-- Décision actée (arbitrage du 28/09/2026) : journal_audit est immuable PAR
-- CONCEPTION (déclencheur + absence de GRANT UPDATE/DELETE) ; un audit qu'on
-- peut effacer en supprimant l'entité auditée n'est plus un audit. On ne
-- l'assouplit donc pas pour laisser passer l'UPDATE d'un ON DELETE SET NULL,
-- et on ne supprime plus une entreprise qui a une histoire : on la DÉSACTIVE.
-- Aucune donnée n'est supprimée ; l'historique et le journal restent intacts.
--
--   - entreprise.desactive_le (NULL = active), posé par admin_plateforme
--     (opération 'modifier_entreprise') — la politique WITH CHECK de
--     entreprise le réserve déjà à platform_admin.
--   - Une entreprise désactivée sort des vues de tableau de bord et des
--     fonctions IFECARM, ne compte plus dans le plafond de creer_prospect(),
--     et l'accès consultant qui la vise devient invalide : entreprise_est_active()
--     est appelée par src/auth/acces.ts EN PLUS de la date de fin. Réactiver
--     l'entreprise (desactive_le = NULL) rétablit l'accès tant que fin_le n'est
--     pas dépassée.
-- =====================================================================

ALTER TABLE entreprise ADD COLUMN desactive_le timestamptz;

-- SECURITY DEFINER : un consultant ne peut pas lire entreprise (RLS) avant
-- d'y être entré, or c'est précisément là qu'on doit savoir si elle est
-- active. Ne renvoie qu'un booléen ; false pour une entreprise inconnue.
CREATE OR REPLACE FUNCTION entreprise_est_active(p_entreprise_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM entreprise e WHERE e.id = p_entreprise_id AND e.desactive_le IS NULL);
$$;

REVOKE EXECUTE ON FUNCTION entreprise_est_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entreprise_est_active(uuid) TO ifecarm_app;

-- creer_prospect : le plafond de 50 ne compte plus les prospects désactivés.
-- (Reprise à l'identique de 0008, seule la condition du comptage change.)
CREATE OR REPLACE FUNCTION creer_prospect(
  p_nom text,
  p_pays text,
  p_secteur text DEFAULT NULL,
  p_duree_acces_jours integer DEFAULT 90
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_id uuid;
  v_actifs integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'creer_prospect : utilisateur non identifié.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = v_uid
      AND r.role IN ('consultant_ifecarm', 'admin_plateforme')
      AND u.actif
      AND e.interne
  ) THEN
    RAISE EXCEPTION 'creer_prospect : réservé aux consultants IFECARM.';
  END IF;

  IF p_nom IS NULL OR btrim(p_nom) = '' OR p_pays IS NULL OR btrim(p_pays) = '' THEN
    RAISE EXCEPTION 'creer_prospect : nom et pays obligatoires.';
  END IF;
  IF p_duree_acces_jours IS NULL OR p_duree_acces_jours NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'creer_prospect : durée d''accès hors bornes (1 à 365 jours).';
  END IF;

  SELECT count(*) INTO v_actifs
  FROM acces_consultant a
  JOIN entreprise e ON e.id = a.entreprise_id
  WHERE a.utilisateur_id = v_uid
    AND e.statut_relation = 'prospect'
    AND e.desactive_le IS NULL
    AND (a.fin_le IS NULL OR a.fin_le >= CURRENT_DATE);
  IF v_actifs >= 50 THEN
    RAISE EXCEPTION 'creer_prospect : plafond de 50 prospects à accès valide atteint.';
  END IF;

  INSERT INTO entreprise (nom, pays, secteur, statut_relation)
  VALUES (btrim(p_nom), btrim(p_pays), p_secteur, 'prospect')
  RETURNING id INTO v_id;

  INSERT INTO abonnement_module (entreprise_id, module)
  VALUES (v_id, 'inspections'), (v_id, 'tableau_bord');

  INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le)
  VALUES (v_uid, v_id, true, CURRENT_DATE + p_duree_acces_jours);

  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (v_uid, NULL, 'creer_prospect', 'entreprise', v_id,
          jsonb_build_object('duree_acces_jours', p_duree_acces_jours));

  RETURN v_id;
END;
$$;

-- =====================================================================
-- Vues de tableau de bord : les entreprises désactivées en sortent.
-- Mêmes colonnes qu'en 0009 (CREATE OR REPLACE VIEW l'exige).
-- =====================================================================

CREATE OR REPLACE VIEW v_indicateurs_formations
WITH (security_invoker = true) AS
SELECT
  e.id AS entreprise_id,
  coalesce(a.recyclages_30j, 0)      AS recyclages_30j,
  coalesce(a.recyclages_7j, 0)       AS recyclages_7j,
  coalesce(a.recyclages_depasses, 0) AS recyclages_depasses,
  coalesce(a.attestations_90j, 0)    AS attestations_90j,
  coalesce(s.sessions_echues, 0)     AS sessions_echues,
  coalesce(s.sessions_realisees, 0)  AS sessions_realisees,
  round(s.sessions_realisees::numeric / NULLIF(s.sessions_echues, 0), 4) AS taux_realisation
FROM entreprise e
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE statut = 'valide' AND expire_le BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::integer AS recyclages_30j,
    count(*) FILTER (WHERE statut = 'valide' AND expire_le BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::integer  AS recyclages_7j,
    count(*) FILTER (WHERE statut = 'valide' AND expire_le < CURRENT_DATE)::integer                            AS recyclages_depasses,
    count(*) FILTER (WHERE statut = 'valide' AND emise_le >= CURRENT_DATE - 90)::integer                       AS attestations_90j
  FROM attestation WHERE entreprise_id = e.id
) a ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE statut <> 'annulee' AND date_fin < CURRENT_DATE)::integer  AS sessions_echues,
    count(*) FILTER (WHERE statut = 'realisee' AND date_fin < CURRENT_DATE)::integer  AS sessions_realisees
  FROM session_formation WHERE entreprise_id = e.id
) s ON true
WHERE e.desactive_le IS NULL;

CREATE OR REPLACE VIEW v_indicateurs_registre
WITH (security_invoker = true) AS
SELECT
  e.id AS entreprise_id,
  coalesce(d.ouvertes, 0)          AS declarations_ouvertes,
  coalesce(d.cloturees, 0)         AS declarations_cloturees,
  coalesce(d.ouvertes_non_qualifiees, 0) AS ouvertes_non_qualifiees,
  coalesce(d.ouvertes_gravite_1, 0) AS ouvertes_gravite_1,
  coalesce(d.ouvertes_gravite_2, 0) AS ouvertes_gravite_2,
  coalesce(d.ouvertes_gravite_3, 0) AS ouvertes_gravite_3,
  coalesce(d.ouvertes_gravite_4, 0) AS ouvertes_gravite_4
FROM entreprise e
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action'))::integer AS ouvertes,
    count(*) FILTER (WHERE statut = 'cloturee')::integer                                  AS cloturees,
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action') AND gravite IS NULL)::integer AS ouvertes_non_qualifiees,
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action') AND gravite = 1)::integer AS ouvertes_gravite_1,
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action') AND gravite = 2)::integer AS ouvertes_gravite_2,
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action') AND gravite = 3)::integer AS ouvertes_gravite_3,
    count(*) FILTER (WHERE statut IN ('a_qualifier', 'en_analyse', 'en_action') AND gravite = 4)::integer AS ouvertes_gravite_4
  FROM declaration WHERE entreprise_id = e.id
) d ON true
WHERE e.desactive_le IS NULL;

-- Actions correctives, toutes origines confondues (déclarations, inspections…).
CREATE OR REPLACE VIEW v_indicateurs_actions
WITH (security_invoker = true) AS
SELECT
  e.id AS entreprise_id,
  coalesce(x.actions_en_retard, 0)            AS actions_en_retard,
  coalesce(x.actions_inspection_en_retard, 0) AS actions_inspection_en_retard,
  coalesce(x.terminees_avec_echeance, 0)      AS terminees_avec_echeance,
  coalesce(x.terminees_dans_les_delais, 0)    AS terminees_dans_les_delais,
  round(x.terminees_dans_les_delais::numeric / NULLIF(x.terminees_avec_echeance, 0), 4) AS taux_traitement_delais
FROM entreprise e
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE statut IN ('a_faire', 'en_cours') AND echeance < CURRENT_DATE)::integer AS actions_en_retard,
    count(*) FILTER (WHERE origine_type = 'inspection' AND statut IN ('a_faire', 'en_cours') AND echeance < CURRENT_DATE)::integer AS actions_inspection_en_retard,
    count(*) FILTER (WHERE statut IN ('realisee', 'verifiee') AND echeance IS NOT NULL AND realisee_le IS NOT NULL)::integer AS terminees_avec_echeance,
    count(*) FILTER (WHERE statut IN ('realisee', 'verifiee') AND echeance IS NOT NULL AND realisee_le IS NOT NULL AND realisee_le <= echeance)::integer AS terminees_dans_les_delais
  FROM action_corrective WHERE entreprise_id = e.id
) x ON true
WHERE e.desactive_le IS NULL;

CREATE OR REPLACE VIEW v_indicateurs_inspections
WITH (security_invoker = true) AS
SELECT
  e.id AS entreprise_id,
  coalesce(i.inspections_terminees_90j, 0) AS inspections_terminees_90j,
  coalesce(r.items_conformes_90j, 0)       AS items_conformes_90j,
  coalesce(r.items_non_conformes_90j, 0)   AS items_non_conformes_90j,
  round(r.items_conformes_90j::numeric / NULLIF(r.items_conformes_90j + r.items_non_conformes_90j, 0), 4) AS taux_conformite_90j,
  coalesce(n.nc_ouvertes_mineure, 0)  AS nc_ouvertes_mineure,
  coalesce(n.nc_ouvertes_majeure, 0)  AS nc_ouvertes_majeure,
  coalesce(n.nc_ouvertes_critique, 0) AS nc_ouvertes_critique
FROM entreprise e
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS inspections_terminees_90j
  FROM inspection
  WHERE entreprise_id = e.id AND statut = 'terminee' AND terminee_le >= now() - interval '90 days'
) i ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE it.resultat = 'conforme')::integer     AS items_conformes_90j,
    count(*) FILTER (WHERE it.resultat = 'non_conforme')::integer AS items_non_conformes_90j
  FROM item_inspection it
  JOIN inspection ins ON ins.id = it.inspection_id
  WHERE it.entreprise_id = e.id AND ins.statut = 'terminee' AND ins.terminee_le >= now() - interval '90 days'
) r ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE nc.gravite = 'mineure')::integer  AS nc_ouvertes_mineure,
    count(*) FILTER (WHERE nc.gravite = 'majeure')::integer  AS nc_ouvertes_majeure,
    count(*) FILTER (WHERE nc.gravite = 'critique')::integer AS nc_ouvertes_critique
  FROM non_conformite nc
  JOIN inspection ins ON ins.id = nc.inspection_id
  WHERE nc.entreprise_id = e.id
    AND ins.statut <> 'annulee'
    AND NOT EXISTS (
      SELECT 1 FROM action_corrective ac
      WHERE ac.origine_type = 'inspection' AND ac.origine_id = nc.id
        AND ac.statut IN ('realisee', 'verifiee'))
) n ON true
WHERE e.desactive_le IS NULL;


-- resume_plateforme : colonne en plus, il faut donc recréer la fonction
-- (le type de retour d'une fonction ne se modifie pas en place).
DROP FUNCTION resume_plateforme();

CREATE FUNCTION resume_plateforme()
RETURNS TABLE (
  clients_actifs integer,
  clients_inactifs integer,
  prospects integer,
  prospects_acces_valide integer,
  entreprises_desactivees integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM exiger_admin_plateforme();

  RETURN QUERY
  SELECT
    (count(*) FILTER (WHERE e.desactive_le IS NULL AND e.statut_relation = 'client' AND e.actif))::integer,
    (count(*) FILTER (WHERE e.desactive_le IS NULL AND e.statut_relation = 'client' AND NOT e.actif))::integer,
    (count(*) FILTER (WHERE e.desactive_le IS NULL AND e.statut_relation = 'prospect'))::integer,
    (count(*) FILTER (WHERE e.desactive_le IS NULL AND e.statut_relation = 'prospect' AND EXISTS (
       SELECT 1 FROM acces_consultant ac
       WHERE ac.entreprise_id = e.id AND (ac.fin_le IS NULL OR ac.fin_le >= CURRENT_DATE))))::integer,
    (count(*) FILTER (WHERE e.desactive_le IS NOT NULL))::integer
  FROM entreprise e
  WHERE NOT e.interne;
END;
$$;

REVOKE EXECUTE ON FUNCTION resume_plateforme() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resume_plateforme() TO ifecarm_app;
