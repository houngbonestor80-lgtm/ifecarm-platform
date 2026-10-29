-- =====================================================================
-- Opportunités de vente (29/10/2026) : vendre aux clients existants ce que leurs échéances rendent nécessaire.
--
-- La plateforme connaît déjà les échéances : recyclages de formation (B2), habilitations (B4), vérifications
-- d'équipements. Elles sont regroupées par entreprise et par objet (« 8 salariés : recyclage SST à partir du 12/12 ») pour
-- l'équipe IFECARM, qui relance le client (WhatsApp prérédigé côté écran) et note la suite.
--
-- MODÈLE
--   opportunites_pour(uid, horizon)  calcul À LA VOLÉE (rien de stocké qui puisse diverger des échéances) ; interne.
--   opportunites_vente(horizon)      l'appelant : consultant (ses mandats en cours) ou admin (tous les clients).
--   suivi_opportunite                historique du suivi (contacte, gagne, perdu, plus_tard) ; une ligne couvre les échéances
--                                    jusqu'à `echeance_couverte` : une échéance plus lointaine qui apparaît ensuite rouvre
--                                    l'opportunité.
--   envoyer_resume_opportunites()    lundi : un e-mail par membre de l'équipe qui a des opportunités à relancer (file
--                                    notification, envoyée par `npm run relances`) ; une fois par semaine au plus.
--
-- RÈGLES
--   - Équipe IFECARM seulement, jamais visible d'un client (aucun droit direct, fonctions SECURITY DEFINER).
--   - Mêmes critères que les alertes existantes : attestation valide la plus récente du salarié pour la formation
--     (0044), habilitation active (0043), équipement actif ; salarié présent ; entreprise active non interne.
--   - Fenêtre : échéances dans les `horizon` prochains jours (90 par défaut) et échues depuis 180 jours au plus.
-- =====================================================================

CREATE TABLE suivi_opportunite (
  id                bigserial PRIMARY KEY,
  entreprise_id     uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('recyclage', 'habilitation', 'verification')),
  cle               text        NOT NULL CHECK (char_length(cle) BETWEEN 1 AND 200),
  statut            text        NOT NULL CHECK (statut IN ('contacte', 'gagne', 'perdu', 'plus_tard')),
  echeance_couverte date        NOT NULL,
  note              text        CHECK (note IS NULL OR char_length(note) <= 1000),
  par               uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  par_nom           text        NOT NULL,
  le                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_suivi_opportunite ON suivi_opportunite (entreprise_id, type, cle, le DESC);
ALTER TABLE suivi_opportunite ENABLE ROW LEVEL SECURITY;
-- Aucun GRANT à ifecarm_app : lecture et écriture par les fonctions ci-dessous seulement.

CREATE TABLE resume_opportunite_envoye (
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  semaine        date NOT NULL,
  PRIMARY KEY (utilisateur_id, semaine)
);
ALTER TABLE resume_opportunite_envoye ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Calcul (interne : jamais appelable par l'application, qui passe par opportunites_vente)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION opportunites_pour(p_uid uuid, p_horizon integer)
RETURNS TABLE (
  entreprise_id uuid, entreprise_nom text, statut_relation text, pays text,
  contact_nom text, contact_telephone text, contact_email text,
  type text, cle text, libelle text, nb integer, premiere_echeance date, derniere_echeance date, echues integer,
  suivi_statut text, suivi_le timestamptz, suivi_par text, suivi_note text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH appelant AS (
    SELECT bool_or(r.role = 'admin_plateforme') AS admin
    FROM role_utilisateur r JOIN utilisateur u ON u.id = r.utilisateur_id JOIN entreprise e ON e.id = u.entreprise_id
    WHERE r.utilisateur_id = p_uid AND u.actif AND e.interne AND r.role IN ('admin_plateforme', 'consultant_ifecarm')
  ),
  perimetre AS (
    SELECT e.* FROM entreprise e, appelant a
    WHERE a.admin IS NOT NULL AND NOT e.interne AND e.desactive_le IS NULL
      AND (a.admin OR EXISTS (SELECT 1 FROM acces_consultant ac WHERE ac.utilisateur_id = p_uid AND ac.entreprise_id = e.id
                                                                  AND (ac.fin_le IS NULL OR ac.fin_le >= current_date)))
  ),
  echeances AS (
    -- Recyclages : l'attestation valide la plus récente de chaque salarié présent, par formation.
    SELECT a.entreprise_id, 'recyclage'::text AS type, sf.formation_id::text AS cle, a.intitule_formation AS libelle, a.expire_le AS echeance
    FROM attestation a
    JOIN participant p ON p.id = a.participant_id
    JOIN session_formation sf ON sf.id = p.session_id
    JOIN salarie s ON s.id = p.salarie_id
    WHERE a.entreprise_id IN (SELECT id FROM perimetre) AND a.statut = 'valide' AND a.expire_le IS NOT NULL
      AND a.expire_le BETWEEN current_date - 180 AND current_date + p_horizon
      AND s.actif AND (s.date_sortie IS NULL OR s.date_sortie >= current_date)
      AND NOT EXISTS (
        SELECT 1 FROM attestation a2
        JOIN participant p2 ON p2.id = a2.participant_id
        JOIN session_formation sf2 ON sf2.id = p2.session_id
        WHERE a2.id <> a.id AND a2.statut = 'valide' AND p2.salarie_id = p.salarie_id AND sf2.formation_id = sf.formation_id
          AND (a2.expire_le IS NULL OR a2.expire_le > a.expire_le))
    UNION ALL
    SELECT h.entreprise_id, 'habilitation', h.type_id::text, t.intitule, h.date_validite
    FROM habilitation h
    JOIN type_habilitation t ON t.id = h.type_id
    JOIN salarie s ON s.id = h.salarie_id
    WHERE h.entreprise_id IN (SELECT id FROM perimetre) AND h.statut = 'active' AND h.date_validite IS NOT NULL
      AND h.date_validite BETWEEN current_date - 180 AND current_date + p_horizon
      AND s.actif AND (s.date_sortie IS NULL OR s.date_sortie >= current_date)
    UNION ALL
    SELECT q.entreprise_id, 'verification', lower(btrim(q.type)), q.type, q.prochaine_verif
    FROM equipement q
    WHERE q.entreprise_id IN (SELECT id FROM perimetre) AND q.actif AND q.prochaine_verif IS NOT NULL
      AND q.prochaine_verif BETWEEN current_date - 180 AND current_date + p_horizon
  ),
  groupes AS (
    SELECT x.entreprise_id, x.type, x.cle, min(x.libelle) AS libelle, count(*)::integer AS nb,
           min(x.echeance) AS premiere_echeance, max(x.echeance) AS derniere_echeance,
           count(*) FILTER (WHERE x.echeance < current_date)::integer AS echues
    FROM echeances x GROUP BY x.entreprise_id, x.type, x.cle
  )
  SELECT g.entreprise_id, e.nom, e.statut_relation, e.pays,
         c.nom, coalesce(NULLIF(btrim(e.telephone), ''), c.telephone), coalesce(NULLIF(btrim(e.email_contact), ''), c.email),
         g.type, g.cle, g.libelle, g.nb, g.premiere_echeance, g.derniere_echeance, g.echues,
         s.statut, s.le, s.par_nom, s.note
  FROM groupes g
  JOIN perimetre e ON e.id = g.entreprise_id
  -- Contact du client : un responsable (admin d'entreprise, responsable QHSE) actif, de préférence avec un téléphone.
  LEFT JOIN LATERAL (
    SELECT u.nom, u.telephone, u.email::text AS email FROM utilisateur u JOIN role_utilisateur r ON r.utilisateur_id = u.id
    WHERE u.entreprise_id = e.id AND u.actif AND r.role IN ('admin_entreprise', 'responsable_qhse')
    ORDER BY (u.telephone IS NULL), r.role, u.nom LIMIT 1
  ) c ON true
  -- Dernier suivi qui couvre toutes les échéances du groupe.
  LEFT JOIN LATERAL (
    SELECT so.statut, so.le, so.par_nom, so.note FROM suivi_opportunite so
    WHERE so.entreprise_id = g.entreprise_id AND so.type = g.type AND so.cle = g.cle AND so.echeance_couverte >= g.derniere_echeance
    ORDER BY so.le DESC LIMIT 1
  ) s ON true
  ORDER BY g.premiere_echeance, e.nom, g.libelle
$$;

CREATE FUNCTION opportunites_vente(p_horizon integer DEFAULT 90)
RETURNS TABLE (
  entreprise_id uuid, entreprise_nom text, statut_relation text, pays text,
  contact_nom text, contact_telephone text, contact_email text,
  type text, cle text, libelle text, nb integer, premiere_echeance date, derniere_echeance date, echues integer,
  suivi_statut text, suivi_le timestamptz, suivi_par text, suivi_note text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé à l''équipe IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF p_horizon IS NULL OR p_horizon NOT BETWEEN 7 AND 365 THEN
    RAISE EXCEPTION 'Horizon : de 7 à 365 jours.' USING ERRCODE = 'IF409';
  END IF;
  RETURN QUERY SELECT * FROM opportunites_pour(NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, p_horizon);
END;
$$;

-- ---------------------------------------------------------------------
-- Suivi d'une opportunité. Codes : IF403, IF404, IF409.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION suivre_opportunite(p_entreprise uuid, p_type text, p_cle text, p_statut text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_derniere date;
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé à l''équipe IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF p_statut IS NULL OR p_statut NOT IN ('contacte', 'gagne', 'perdu', 'plus_tard') THEN
    RAISE EXCEPTION 'Statut inconnu.' USING ERRCODE = 'IF409';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN
    RAISE EXCEPTION 'Note : 1000 caractères au maximum.' USING ERRCODE = 'IF409';
  END IF;
  -- L'opportunité doit être dans le périmètre de l'appelant (même calcul que la liste) : 365 jours couvre toute liste affichée.
  SELECT o.derniere_echeance INTO v_derniere FROM opportunites_pour(v_uid, 365) o
  WHERE o.entreprise_id = p_entreprise AND o.type = p_type AND o.cle = p_cle;
  IF v_derniere IS NULL THEN
    RAISE EXCEPTION 'Opportunité introuvable.' USING ERRCODE = 'IF404';
  END IF;
  INSERT INTO suivi_opportunite (entreprise_id, type, cle, statut, echeance_couverte, note, par, par_nom)
  VALUES (p_entreprise, p_type, p_cle, p_statut, v_derniere, NULLIF(btrim(p_note), ''), v_uid,
          coalesce((SELECT nom FROM utilisateur WHERE id = v_uid), 'IFECARM GROUP'));
END;
$$;

-- ---------------------------------------------------------------------
-- Résumé hebdomadaire (lundi, lancé par npm run relances) : file d'e-mails, une fois par semaine et par personne.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION envoyer_resume_opportunites(p_url text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_u record;
  v_interne uuid;
  v_semaine date := date_trunc('week', current_date)::date;
  v_nb integer;
  v_echues integer;
  v_detail text;
  v_total integer := 0;
BEGIN
  SELECT id INTO v_interne FROM entreprise WHERE interne ORDER BY cree_le LIMIT 1;
  IF v_interne IS NULL THEN RETURN 0; END IF;
  FOR v_u IN
    SELECT DISTINCT u.id, u.email::text AS email, u.nom FROM utilisateur u
    JOIN role_utilisateur r ON r.utilisateur_id = u.id JOIN entreprise e ON e.id = u.entreprise_id
    WHERE u.actif AND e.interne AND r.role IN ('admin_plateforme', 'consultant_ifecarm')
      AND NOT EXISTS (SELECT 1 FROM resume_opportunite_envoye x WHERE x.utilisateur_id = u.id AND x.semaine = v_semaine)
  LOOP
    SELECT count(*)::integer, coalesce(sum(o.echues), 0)::integer,
           string_agg('- ' || o.entreprise_nom || ' : ' || o.libelle || ' (' || o.nb || ', dès le ' || to_char(o.premiere_echeance, 'DD/MM/YYYY') || ')',
                      E'\n' ORDER BY o.premiere_echeance) FILTER (WHERE o.rang <= 15)
      INTO v_nb, v_echues, v_detail
    FROM (SELECT p.*, row_number() OVER (ORDER BY p.premiere_echeance) AS rang
          FROM opportunites_pour(v_u.id, 90) p WHERE p.suivi_statut IS NULL) o;
    INSERT INTO resume_opportunite_envoye (utilisateur_id, semaine) VALUES (v_u.id, v_semaine);
    CONTINUE WHEN v_nb = 0;
    INSERT INTO notification (entreprise_id, canal, destinataire, sujet, corps, module)
    VALUES (v_interne, 'email', v_u.email,
            v_nb || ' opportunité' || CASE WHEN v_nb > 1 THEN 's' ELSE '' END || ' de vente à relancer cette semaine',
            'Bonjour ' || v_u.nom || E',\n\n'
            || 'Vos clients ont ' || v_nb || ' échéance' || CASE WHEN v_nb > 1 THEN 's' ELSE '' END || ' à vendre dans les 90 prochains jours'
            || CASE WHEN v_echues > 0 THEN ' (dont ' || v_echues || ' élément' || CASE WHEN v_echues > 1 THEN 's' ELSE '' END || ' déjà échu' || CASE WHEN v_echues > 1 THEN 's' ELSE '' END || ')' ELSE '' END
            || E' :\n\n' || coalesce(v_detail, '') || CASE WHEN v_nb > 15 THEN E'\n- …' ELSE '' END
            || E'\n\nRelancez-les en un clic (message WhatsApp prérédigé) : ' || coalesce(p_url, '') || E'/opportunites\n\nIFECARM GROUP',
            'opportunites');
    v_total := v_total + 1;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION opportunites_pour(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION opportunites_vente(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION suivre_opportunite(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION envoyer_resume_opportunites(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opportunites_vente(integer) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION suivre_opportunite(uuid, text, text, text, text) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION envoyer_resume_opportunites(text) TO ifecarm_app;
