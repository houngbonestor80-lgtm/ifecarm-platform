-- =====================================================================
-- Mini-audit gratuit public (29/10/2026) : capter des prospects.
--
-- Un visiteur SANS COMPTE répond à un questionnaire court, laisse ses coordonnées et obtient tout de suite son score et
-- un CODE DE SUIVI (lien de son résultat). L'équipe IFECARM voit la demande, la rappelle et la convertit en prospect.
--
-- MODÈLE
--   referentiel_autodiagnostic.public  le questionnaire est proposé sur la page publique (choix de l'admin).
--   mini_audit                         une demande : questionnaire COPIÉ, réponses, résultat calculé EN BASE, contact,
--                                      suivi (nouveau, contacte, converti, sans_suite), prospect créé.
--
-- RÈGLES
--   - Le public n'a AUCUN droit direct sur mini_audit : tout passe par des fonctions SECURITY DEFINER.
--       questionnaires_mini_audit()  questionnaires publics actifs (lecture sans compte).
--       soumettre_mini_audit()       contrôle les réponses, calcule le score (calculer_resultat_autodiagnostic, même
--                                    formule que B1), limite 5 demandes par heure et par IP, 3 par jour et par e-mail.
--       lire_mini_audit(code)        le résultat, pour qui détient le code (jamais l'e-mail ni le téléphone).
--   - Le code de suivi (MA-XXXX-XXXX-XXXX, 60 bits aléatoires) sert de secret : impossible à deviner.
--   - Équipe IFECARM (consultant, admin) : lit toutes les demandes (RLS), change le suivi (suivre_mini_audit),
--     convertit en prospect (convertir_mini_audit, réutilise creer_prospect : plafond, modules, accès, journal).
--     Converti et sans suite sont définitifs. Jamais visible d'un client.
--   - Données personnelles : consentement obligatoire, adresse IP conservée pour la limitation.
-- =====================================================================

ALTER TABLE referentiel_autodiagnostic ADD COLUMN public boolean NOT NULL DEFAULT false;

CREATE TABLE mini_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_suivi        text        NOT NULL UNIQUE CHECK (code_suivi ~ '^MA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  referentiel_code  text        NOT NULL,
  referentiel_titre text        NOT NULL,
  definition        jsonb       NOT NULL CHECK (definition_autodiagnostic_valide(definition)),
  reponses          jsonb       NOT NULL CHECK (jsonb_typeof(reponses) = 'object'),
  resultat          jsonb       NOT NULL,
  score_global      integer     NOT NULL CHECK (score_global BETWEEN 0 AND 100),
  niveau_libelle    text        NOT NULL,
  -- Contact
  nom_contact       text        NOT NULL CHECK (char_length(btrim(nom_contact)) BETWEEN 1 AND 200),
  fonction          text        CHECK (fonction IS NULL OR char_length(fonction) <= 200),
  entreprise_nom    text        NOT NULL CHECK (char_length(btrim(entreprise_nom)) BETWEEN 1 AND 200),
  email             citext      NOT NULL CHECK (email ~ '^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$' AND char_length(email) <= 200),
  telephone         text        CHECK (telephone IS NULL OR telephone ~ '^\+?[0-9 .()-]{6,30}$'),
  pays              text        NOT NULL REFERENCES pays_intervention(code),
  secteur           text        CHECK (secteur IS NULL OR char_length(secteur) <= 200),
  effectif          text        CHECK (effectif IS NULL OR effectif IN ('1-9', '10-49', '50-249', '250+')),
  consentement      boolean     NOT NULL CHECK (consentement),
  adresse_ip        inet,
  cree_le           timestamptz NOT NULL DEFAULT now(),
  -- Suivi par l'équipe IFECARM
  statut            text        NOT NULL DEFAULT 'nouveau' CHECK (statut IN ('nouveau', 'contacte', 'converti', 'sans_suite')),
  suivi_par         uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  suivi_le          timestamptz,
  entreprise_id     uuid        REFERENCES entreprise(id) ON DELETE SET NULL,
  CHECK (statut <> 'converti' OR suivi_le IS NOT NULL)
);
CREATE INDEX idx_mini_audit_liste ON mini_audit (cree_le DESC);
CREATE INDEX idx_mini_audit_ip ON mini_audit (adresse_ip, cree_le);
CREATE INDEX idx_mini_audit_email ON mini_audit (email, cree_le);

ALTER TABLE mini_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY mini_audit_equipe ON mini_audit FOR SELECT USING (est_consultant_ou_admin_courant());
-- Lecture seule pour l'application ; toute écriture passe par les fonctions ci-dessous.
GRANT SELECT ON mini_audit TO ifecarm_app;

-- ---------------------------------------------------------------------
-- Public : questionnaires proposés
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION questionnaires_mini_audit()
RETURNS TABLE (code text, titre text, description text, duree_estimee_minutes integer, avertissement text, definition jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.code, r.titre, r.description, r.duree_estimee_minutes, r.avertissement, r.definition
  FROM referentiel_autodiagnostic r WHERE r.public AND r.actif ORDER BY r.duree_estimee_minutes, r.titre
$$;

-- ---------------------------------------------------------------------
-- Public : envoi d'une demande. Codes : IF409 (invalide), IF429 (trop de demandes).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soumettre_mini_audit(p_referentiel text, p_reponses jsonb, p_contact jsonb, p_adresse_ip inet)
RETURNS TABLE (code_suivi text, score_global integer, niveau_libelle text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ref referentiel_autodiagnostic%ROWTYPE;
  v_codes text[];
  v_ids text[];
  v_email citext := lower(btrim(p_contact->>'email'));
  v_resultat jsonb;
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_octets bytea;
  i integer;
BEGIN
  SELECT * INTO v_ref FROM referentiel_autodiagnostic r WHERE r.code = p_referentiel AND r.public AND r.actif;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Questionnaire introuvable.' USING ERRCODE = 'IF409';
  END IF;
  IF p_contact IS NULL OR jsonb_typeof(p_contact) <> 'object' THEN
    RAISE EXCEPTION 'Coordonnées manquantes.' USING ERRCODE = 'IF409';
  END IF;
  IF coalesce((p_contact->>'consentement')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Votre accord pour être recontacté est nécessaire.' USING ERRCODE = 'IF409';
  END IF;

  -- Limitation : 5 demandes par heure et par adresse IP, 3 par jour et par e-mail.
  IF p_adresse_ip IS NOT NULL AND (SELECT count(*) FROM mini_audit m WHERE m.adresse_ip = p_adresse_ip AND m.cree_le > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'Trop de demandes depuis cette connexion. Réessayez dans une heure.' USING ERRCODE = 'IF429';
  END IF;
  IF (SELECT count(*) FROM mini_audit m WHERE m.email = v_email AND m.cree_le > now() - interval '1 day') >= 3 THEN
    RAISE EXCEPTION 'Vous avez déjà envoyé plusieurs demandes aujourd''hui. Nous vous recontactons.' USING ERRCODE = 'IF429';
  END IF;

  -- Réponses : un objet { idQuestion: codeRéponse } couvrant TOUTES les questions, avec des codes de l'échelle.
  IF p_reponses IS NULL OR jsonb_typeof(p_reponses) <> 'object' THEN
    RAISE EXCEPTION 'Réponses invalides.' USING ERRCODE = 'IF409';
  END IF;
  SELECT array_agg(e->>'code') INTO v_codes FROM jsonb_array_elements(v_ref.definition->'echelleReponses') e;
  SELECT array_agg(q->>'id') INTO v_ids
    FROM jsonb_array_elements(v_ref.definition->'themes') t, jsonb_array_elements(t->'questions') q;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_reponses) r WHERE NOT (r.key = ANY (v_ids)) OR jsonb_typeof(r.value) <> 'string' OR NOT ((r.value #>> '{}') = ANY (v_codes)))
     OR EXISTS (SELECT 1 FROM unnest(v_ids) id WHERE NOT p_reponses ? id) THEN
    RAISE EXCEPTION 'Répondez à toutes les questions.' USING ERRCODE = 'IF409';
  END IF;

  v_resultat := calculer_resultat_autodiagnostic(v_ref.definition, p_reponses);

  -- Code de suivi : 12 caractères tirés de 32 symboles sans ambiguïté (pas de 0/O, 1/I) ; nouvel essai en cas de collision.
  LOOP
    v_octets := gen_random_bytes(12);
    v_code := 'MA-';
    FOR i IN 0..11 LOOP
      v_code := v_code || substr(v_alphabet, (get_byte(v_octets, i) % 32) + 1, 1) || CASE WHEN i IN (3, 7) THEN '-' ELSE '' END;
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM mini_audit m WHERE m.code_suivi = v_code);
  END LOOP;

  BEGIN
    INSERT INTO mini_audit (code_suivi, referentiel_code, referentiel_titre, definition, reponses, resultat, score_global, niveau_libelle,
                            nom_contact, fonction, entreprise_nom, email, telephone, pays, secteur, effectif, consentement, adresse_ip)
    VALUES (v_code, v_ref.code, v_ref.titre, v_ref.definition, p_reponses, v_resultat, (v_resultat->>'globalScore')::integer,
            v_resultat->'niveau'->>'libelle', btrim(p_contact->>'nom'), NULLIF(btrim(p_contact->>'fonction'), ''),
            btrim(p_contact->>'entreprise'), v_email, NULLIF(btrim(p_contact->>'telephone'), ''), p_contact->>'pays',
            NULLIF(btrim(p_contact->>'secteur'), ''), NULLIF(p_contact->>'effectif', ''), true, p_adresse_ip);
  EXCEPTION
    WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'Coordonnées incomplètes ou invalides (nom, entreprise, e-mail, pays).' USING ERRCODE = 'IF409';
  END;

  RETURN QUERY SELECT v_code, (v_resultat->>'globalScore')::integer, v_resultat->'niveau'->>'libelle';
END;
$$;

-- ---------------------------------------------------------------------
-- Public : résultat d'une demande, pour qui détient le code.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lire_mini_audit(p_code text)
RETURNS TABLE (code_suivi text, referentiel_titre text, entreprise_nom text, nom_contact text, cree_le timestamptz,
               resultat jsonb, avertissement text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.code_suivi, m.referentiel_titre, m.entreprise_nom, m.nom_contact, m.cree_le, m.resultat,
         coalesce(r.avertissement, 'Diagnostic indicatif. Il ne remplace pas un audit.')
  FROM mini_audit m LEFT JOIN referentiel_autodiagnostic r ON r.code = m.referentiel_code
  WHERE m.code_suivi = upper(btrim(p_code))
$$;

-- Destinataires de l'alerte « nouvelle demande » : administrateurs IFECARM actifs.
CREATE OR REPLACE FUNCTION destinataires_alerte_mini_audit() RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT u.email::text FROM utilisateur u
  JOIN role_utilisateur r ON r.utilisateur_id = u.id
  JOIN entreprise e ON e.id = u.entreprise_id
  WHERE r.role = 'admin_plateforme' AND u.actif AND e.interne
$$;

-- ---------------------------------------------------------------------
-- Équipe IFECARM : suivi et conversion. Codes : IF403, IF404, IF409.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION suivre_mini_audit(p_id uuid, p_statut text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_statut text;
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé à l''équipe IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  IF p_statut NOT IN ('nouveau', 'contacte', 'sans_suite') THEN
    RAISE EXCEPTION 'Statut inconnu.' USING ERRCODE = 'IF409';
  END IF;
  SELECT m.statut INTO v_statut FROM mini_audit m WHERE m.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable.' USING ERRCODE = 'IF404';
  END IF;
  IF v_statut IN ('converti', 'sans_suite') THEN
    RAISE EXCEPTION 'Cette demande est close.' USING ERRCODE = 'IF409';
  END IF;
  UPDATE mini_audit SET statut = p_statut, suivi_par = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, suivi_le = now()
  WHERE id = p_id;
END;
$$;

-- Crée le prospect (creer_prospect : droits, plafond, modules, accès du consultant, journal), y reporte les
-- coordonnées et le service « audit », puis clôt la demande. Renvoie l'identifiant du prospect.
CREATE OR REPLACE FUNCTION convertir_mini_audit(p_id uuid) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_m mini_audit%ROWTYPE;
  v_entreprise uuid;
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé à l''équipe IFECARM GROUP.' USING ERRCODE = 'IF403';
  END IF;
  SELECT * INTO v_m FROM mini_audit m WHERE m.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable.' USING ERRCODE = 'IF404';
  END IF;
  IF v_m.statut IN ('converti', 'sans_suite') THEN
    RAISE EXCEPTION 'Cette demande est close.' USING ERRCODE = 'IF409';
  END IF;

  v_entreprise := creer_prospect(v_m.entreprise_nom, v_m.pays, v_m.secteur);
  UPDATE entreprise SET telephone = v_m.telephone, email_contact = v_m.email::text WHERE id = v_entreprise;
  PERFORM definir_souhaits_prospect(v_entreprise, ARRAY['audit']::text[], '[]'::jsonb, NULL);
  UPDATE mini_audit SET statut = 'converti', entreprise_id = v_entreprise,
         suivi_par = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, suivi_le = now()
  WHERE id = p_id;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (NULLIF(current_setting('app.utilisateur_id', true), '')::uuid, v_entreprise, 'conversion', 'mini_audit', p_id,
          jsonb_build_object('code_suivi', v_m.code_suivi, 'score', v_m.score_global));
  RETURN v_entreprise;
END;
$$;

REVOKE EXECUTE ON FUNCTION questionnaires_mini_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soumettre_mini_audit(text, jsonb, jsonb, inet) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lire_mini_audit(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION destinataires_alerte_mini_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION suivre_mini_audit(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION convertir_mini_audit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questionnaires_mini_audit() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION soumettre_mini_audit(text, jsonb, jsonb, inet) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION lire_mini_audit(text) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION destinataires_alerte_mini_audit() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION suivre_mini_audit(uuid, text) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION convertir_mini_audit(uuid) TO ifecarm_app;
