-- =====================================================================
-- Plateforme QHSE IFECARM — module B6 : tableau de bord
--
-- Deux niveaux d'agrégation, sans table de KPI dupliquée :
--
--   1. Vues CLIENT (security_invoker = true) au-dessus des tables déjà
--      protégées. Elles héritent de la RLS de chaque table sous-jacente et
--      ne renvoient que l'entreprise du contexte courant. Pas de job de
--      rafraîchissement, pas de désynchronisation possible.
--      Sans security_invoker, une vue s'exécuterait avec les droits de son
--      propriétaire (ifecarm_migrate, exempté du RLS) et exposerait toutes
--      les entreprises — cf. correction bloquante de 0005.
--
--   2. Fonctions IFECARM (vue transverse) en SECURITY DEFINER, qui ne
--      renvoient que des COMPTAGES et des ratios, jamais une donnée
--      personnelle ni une ligne d'un client. C'est la seule façon de donner
--      à IFECARM une vue globale sans rouvrir la porte platform_admin que
--      B2 et B3 ont volontairement fermée (sessions, participants,
--      attestations, déclarations, actions : aucune échappatoire directe).
--      Même standard que verifier_attestation : search_path fixé, rôle
--      REVÉRIFIÉ à l'intérieur de la fonction (pas seulement à l'appel),
--      EXECUTE retiré à PUBLIC.
--
-- Habilitations (B4) : hors périmètre, le module n'existe pas encore dans
-- le dépôt. Ses indicateurs s'ajouteront quand il sera écrit.
--
-- Définitions retenues (à valider, pas figées) :
--   - recyclages_30j inclut les recyclages_7j (échéance dans les 30 jours ;
--     7 jours en est un sous-ensemble) ; recyclages_depasses = déjà expirés.
--   - taux_realisation : sessions réalisées / sessions échues non annulées.
--   - taux_conformite_90j : items conformes / (conformes + non conformes)
--     des inspections terminées sur 90 jours ; les non-applicables sont
--     exclus ; agrégé sur les items (pas moyenne de moyennes).
--   - non-conformité "ouverte" : aucune action corrective d'origine
--     inspection réalisée ou vérifiée ne la traite (une action abandonnée
--     ne la clôt pas).
--   - taux_traitement_delais : actions réalisées ou vérifiées à leur échéance
--     ou avant / actions réalisées ou vérifiées ayant une échéance.
-- =====================================================================

-- =====================================================================
-- 1. VUES CLIENT
-- Chaque vue part d'entreprise : sous RLS, un client n'y voit que sa ligne,
-- avec des zéros (et non aucune ligne) s'il n'a encore rien saisi.
-- =====================================================================

CREATE VIEW v_indicateurs_formations
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
) s ON true;

CREATE VIEW v_indicateurs_registre
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
) d ON true;

-- Actions correctives, toutes origines confondues (déclarations, inspections…).
CREATE VIEW v_indicateurs_actions
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
) x ON true;

CREATE VIEW v_indicateurs_inspections
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
) n ON true;

GRANT SELECT ON v_indicateurs_formations   TO ifecarm_app;
GRANT SELECT ON v_indicateurs_registre     TO ifecarm_app;
GRANT SELECT ON v_indicateurs_actions      TO ifecarm_app;
GRANT SELECT ON v_indicateurs_inspections  TO ifecarm_app;

-- =====================================================================
-- 2. VUE TRANSVERSE IFECARM
-- =====================================================================

-- Contrôle d'accès commun. Appelée UNIQUEMENT depuis les fonctions ci-dessous
-- (qui s'exécutent avec les droits du propriétaire) : aucun droit EXECUTE
-- pour ifecarm_app. Exige LES DEUX : le contexte platform_admin posé par
-- withPlatformAdmin (qui a déjà revérifié le rôle et journalisé l'opération)
-- ET le rôle admin_plateforme d'un utilisateur actif de l'entreprise interne.
CREATE OR REPLACE FUNCTION exiger_admin_plateforme() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  IF current_setting('app.platform_admin', true) IS DISTINCT FROM 'true' OR v_uid IS NULL THEN
    RAISE EXCEPTION 'Accès admin_plateforme requis.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM role_utilisateur r
    JOIN utilisateur u ON u.id = r.utilisateur_id
    JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = v_uid AND r.role = 'admin_plateforme' AND u.actif AND e.interne
  ) THEN
    RAISE EXCEPTION 'Accès admin_plateforme refusé : rôle absent.';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION exiger_admin_plateforme() FROM PUBLIC;

-- Une ligne par entreprise cliente ou prospect (l'entreprise interne IFECARM
-- est exclue). Comptages et ratios uniquement.
CREATE OR REPLACE FUNCTION indicateurs_plateforme()
RETURNS TABLE (
  entreprise_id uuid,
  nom text,
  statut_relation text,
  actif boolean,
  recyclages_30j integer,
  recyclages_7j integer,
  recyclages_depasses integer,
  declarations_ouvertes integer,
  actions_en_retard integer,
  actions_inspection_en_retard integer,
  inspections_terminees_90j integer,
  taux_conformite_90j numeric,
  nc_ouvertes_critique integer,
  nc_ouvertes_total integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM exiger_admin_plateforme();

  RETURN QUERY
  SELECT
    e.id, e.nom, e.statut_relation, e.actif,
    f.recyclages_30j, f.recyclages_7j, f.recyclages_depasses,
    g.declarations_ouvertes,
    a.actions_en_retard, a.actions_inspection_en_retard,
    i.inspections_terminees_90j, i.taux_conformite_90j,
    i.nc_ouvertes_critique,
    (i.nc_ouvertes_mineure + i.nc_ouvertes_majeure + i.nc_ouvertes_critique)
  FROM entreprise e
  JOIN v_indicateurs_formations  f ON f.entreprise_id = e.id
  JOIN v_indicateurs_registre    g ON g.entreprise_id = e.id
  JOIN v_indicateurs_actions     a ON a.entreprise_id = e.id
  JOIN v_indicateurs_inspections i ON i.entreprise_id = e.id
  WHERE NOT e.interne
  ORDER BY e.nom;
END;
$$;

-- Compteurs globaux pour l'administration.
CREATE OR REPLACE FUNCTION resume_plateforme()
RETURNS TABLE (
  clients_actifs integer,
  clients_inactifs integer,
  prospects integer,
  prospects_acces_valide integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM exiger_admin_plateforme();

  RETURN QUERY
  SELECT
    (count(*) FILTER (WHERE e.statut_relation = 'client'   AND e.actif))::integer,
    (count(*) FILTER (WHERE e.statut_relation = 'client'   AND NOT e.actif))::integer,
    (count(*) FILTER (WHERE e.statut_relation = 'prospect'))::integer,
    (count(*) FILTER (WHERE e.statut_relation = 'prospect' AND EXISTS (
       SELECT 1 FROM acces_consultant ac
       WHERE ac.entreprise_id = e.id AND (ac.fin_le IS NULL OR ac.fin_le >= CURRENT_DATE))))::integer
  FROM entreprise e
  WHERE NOT e.interne;
END;
$$;

REVOKE EXECUTE ON FUNCTION indicateurs_plateforme() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resume_plateforme() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION indicateurs_plateforme() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION resume_plateforme() TO ifecarm_app;
