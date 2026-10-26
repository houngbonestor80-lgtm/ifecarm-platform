-- =====================================================================
-- B1 : autodiagnostic QHSE (07/10/2026).
--
-- PÉRIMÈTRE (décisions de l'utilisateur) : le consultant conduit l'évaluation chez / avec le client ; le client la
-- CONSULTE une fois terminée (responsable QHSE et admin d'entreprise seulement). Les questionnaires sont les 5
-- référentiels ISO du site vitrine (9001, 14001, 45001, 22000, 50001) + ceux que l'administrateur ajoute ou modifie.
-- Suites : rapport PDF, historique et comparaison, plan d'action depuis les écarts, volet du tableau de bord.
--
-- MODÈLE
--   referentiel_autodiagnostic  catalogue global (entreprise_id absent), géré par l'admin (gerer_catalogue_autodiagnostic),
--                               lu par l'équipe IFECARM. `definition` jsonb = { echelleReponses, niveaux, themes } (mêmes
--                               clés que les fichiers du site), validée par definition_autodiagnostic_valide().
--   autodiagnostic              une évaluation d'une entreprise. Le questionnaire est COPIÉ (figé) à la création, par
--                               déclencheur : modifier le catalogue plus tard ne change jamais une évaluation existante.
--   autodiagnostic_action       lien question → action corrective créée depuis l'écart (une action par question).
--
-- RÈGLES
--   - Le SCORE est calculé EN BASE (terminer_autodiagnostic) : le navigateur et le serveur d'application ne peuvent pas
--     écrire un résultat falsifié. Même formule que le site : Σ(poids × coefficient) ÷ Σ(poids), en %, par thème et global.
--   - Terminer exige que TOUTES les questions aient une réponse. Une évaluation terminée est DÉFINITIVE (réponses,
--     commentaires, questionnaire, résultat, site, date figés) ; la supprimer est réservé à l'administrateur.
--   - Écriture : équipe IFECARM (RLS, comme B4). Lecture : l'équipe voit tout ; le client (admin d'entreprise,
--     responsable QHSE) ne lit que les évaluations TERMINÉES de son entreprise ; aucun autre rôle du client.
--   - Actions : réutilisent action_corrective (origine_type 'audit', origine_id = évaluation terminée de la même
--     entreprise, contrôlé par déclencheur) ; visibles du client comme celles des inspections.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Module
-- ---------------------------------------------------------------------
ALTER TABLE abonnement_module DROP CONSTRAINT abonnement_module_module_check;
ALTER TABLE abonnement_module ADD CONSTRAINT abonnement_module_module_check
  CHECK (module IN ('formations','incidents','habilitations','inspections','tableau_bord','autodiagnostic'));

-- ---------------------------------------------------------------------
-- 2. Validation d'un questionnaire (échelle, niveaux, thèmes, questions)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION definition_autodiagnostic_valide(p jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  e jsonb; n jsonb; t jsonb; q jsonb;
  v_ids text[] := '{}';
  v_codes text[] := '{}';
  v_attendu integer := 0;
  v_nb_questions integer := 0;
  v_coef_max numeric := 0;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF jsonb_typeof(p->'echelleReponses') <> 'array' OR jsonb_array_length(p->'echelleReponses') < 2 THEN RETURN false; END IF;
  IF jsonb_typeof(p->'niveaux') <> 'array' OR jsonb_array_length(p->'niveaux') < 1 THEN RETURN false; END IF;
  IF jsonb_typeof(p->'themes') <> 'array' OR jsonb_array_length(p->'themes') < 1 THEN RETURN false; END IF;

  -- Échelle de réponses : code unique, libellé, coefficient de 0 à 1 ; une réponse vaut 1 (pleine conformité).
  FOR e IN SELECT * FROM jsonb_array_elements(p->'echelleReponses') LOOP
    IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'code') <> 'string' OR jsonb_typeof(e->'libelle') <> 'string'
       OR jsonb_typeof(e->'coefficient') <> 'number' OR (e->>'code') !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN RETURN false; END IF;
    IF (e->>'coefficient')::numeric < 0 OR (e->>'coefficient')::numeric > 1 THEN RETURN false; END IF;
    IF (e->>'code') = ANY (v_codes) THEN RETURN false; END IF;
    v_codes := v_codes || (e->>'code');
    v_coef_max := greatest(v_coef_max, (e->>'coefficient')::numeric);
  END LOOP;
  IF v_coef_max <> 1 THEN RETURN false; END IF;

  -- Niveaux : entiers, contigus, de 0 à 100, dans l'ordre.
  FOR n IN SELECT * FROM jsonb_array_elements(p->'niveaux') LOOP
    IF jsonb_typeof(n) <> 'object' OR jsonb_typeof(n->'libelle') <> 'string' OR jsonb_typeof(n->'message') <> 'string'
       OR jsonb_typeof(n->'seuilMin') <> 'number' OR jsonb_typeof(n->'seuilMax') <> 'number' THEN RETURN false; END IF;
    IF (n->>'seuilMin') !~ '^\d+$' OR (n->>'seuilMax') !~ '^\d+$' THEN RETURN false; END IF;
    IF (n->>'seuilMin')::integer <> v_attendu OR (n->>'seuilMax')::integer < (n->>'seuilMin')::integer THEN RETURN false; END IF;
    v_attendu := (n->>'seuilMax')::integer + 1;
  END LOOP;
  IF v_attendu <> 101 THEN RETURN false; END IF;

  -- Thèmes et questions : identifiants de question uniques dans tout le questionnaire, poids entier de 1 à 10.
  FOR t IN SELECT * FROM jsonb_array_elements(p->'themes') LOOP
    IF jsonb_typeof(t) <> 'object' OR jsonb_typeof(t->'code') <> 'string' OR jsonb_typeof(t->'libelle') <> 'string'
       OR jsonb_typeof(t->'questions') <> 'array' OR jsonb_array_length(t->'questions') < 1 THEN RETURN false; END IF;
    FOR q IN SELECT * FROM jsonb_array_elements(t->'questions') LOOP
      IF jsonb_typeof(q) <> 'object' OR jsonb_typeof(q->'id') <> 'string' OR jsonb_typeof(q->'texte') <> 'string'
         OR jsonb_typeof(q->'recommandation') <> 'string' OR jsonb_typeof(q->'poids') <> 'number'
         OR (q->>'id') !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN RETURN false; END IF;
      IF (q->>'poids') !~ '^\d+$' OR (q->>'poids')::integer < 1 OR (q->>'poids')::integer > 10 THEN RETURN false; END IF;
      IF q ? 'aide' AND jsonb_typeof(q->'aide') NOT IN ('string', 'null') THEN RETURN false; END IF;
      IF (q->>'id') = ANY (v_ids) THEN RETURN false; END IF;
      v_ids := v_ids || (q->>'id');
      v_nb_questions := v_nb_questions + 1;
    END LOOP;
  END LOOP;
  RETURN v_nb_questions >= 1 AND v_nb_questions <= 300;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Calcul du résultat (même formule que le site vitrine)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculer_resultat_autodiagnostic(p_definition jsonb, p_reponses jsonb) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_coef jsonb := '{}'::jsonb;
  e jsonb; t jsonb; q jsonb;
  v_theme_pondere float8; v_theme_poids float8;
  v_global_pondere float8 := 0; v_global_poids float8 := 0;
  v_coefficient float8;
  v_themes jsonb := '[]'::jsonb;
  v_reco jsonb[] := '{}';
  v_score integer; v_niveau jsonb; v_ordre integer := 0;
  v_reco_tri jsonb;
BEGIN
  FOR e IN SELECT * FROM jsonb_array_elements(p_definition->'echelleReponses') LOOP
    v_coef := v_coef || jsonb_build_object(e->>'code', (e->>'coefficient')::float8);
  END LOOP;

  FOR t IN SELECT * FROM jsonb_array_elements(p_definition->'themes') LOOP
    v_theme_pondere := 0; v_theme_poids := 0;
    FOR q IN SELECT * FROM jsonb_array_elements(t->'questions') LOOP
      v_coefficient := CASE WHEN p_reponses ? (q->>'id') THEN coalesce((v_coef->>(p_reponses->>(q->>'id')))::float8, 0) ELSE 0 END;
      v_theme_pondere := v_theme_pondere + (q->>'poids')::float8 * v_coefficient;
      v_theme_poids := v_theme_poids + (q->>'poids')::float8;
      IF v_coefficient < 1 THEN
        v_ordre := v_ordre + 1;
        v_reco := v_reco || jsonb_build_object('questionId', q->>'id', 'texte', q->>'recommandation', 'poids', (q->>'poids')::integer,
                                               'themeCode', t->>'code', 'themeLibelle', t->>'libelle', 'ordre', v_ordre);
      END IF;
    END LOOP;
    v_themes := v_themes || jsonb_build_object('code', t->>'code', 'libelle', t->>'libelle',
      'score', CASE WHEN v_theme_poids > 0 THEN floor(v_theme_pondere / v_theme_poids * 100 + 0.5)::integer ELSE 0 END);
    v_global_pondere := v_global_pondere + v_theme_pondere;
    v_global_poids := v_global_poids + v_theme_poids;
  END LOOP;

  v_score := CASE WHEN v_global_poids > 0 THEN floor(v_global_pondere / v_global_poids * 100 + 0.5)::integer ELSE 0 END;
  SELECT n INTO v_niveau FROM jsonb_array_elements(p_definition->'niveaux') n
   WHERE v_score >= (n->>'seuilMin')::integer AND v_score <= (n->>'seuilMax')::integer LIMIT 1;
  IF v_niveau IS NULL THEN v_niveau := (p_definition->'niveaux')->0; END IF;

  -- Recommandations : poids décroissant, à poids égal dans l'ordre du questionnaire (tri stable, comme le site).
  SELECT coalesce(jsonb_agg(r - 'ordre' ORDER BY (r->>'poids')::integer DESC, (r->>'ordre')::integer), '[]'::jsonb)
    INTO v_reco_tri FROM unnest(v_reco) r;

  RETURN jsonb_build_object('globalScore', v_score, 'niveau', v_niveau, 'themes', v_themes, 'recommendations', v_reco_tri);
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Catalogue des référentiels
-- ---------------------------------------------------------------------
CREATE TABLE referentiel_autodiagnostic (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text        NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  titre                 text        NOT NULL CHECK (length(titre) BETWEEN 1 AND 200),
  description           text        NOT NULL CHECK (length(description) <= 1000),
  duree_estimee_minutes integer     NOT NULL CHECK (duree_estimee_minutes BETWEEN 1 AND 240),
  avertissement         text        NOT NULL CHECK (length(avertissement) <= 1000),
  definition            jsonb       NOT NULL CHECK (definition_autodiagnostic_valide(definition)),
  actif                 boolean     NOT NULL DEFAULT true,
  cree_le               timestamptz NOT NULL DEFAULT now(),
  modifie_le            timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION horodater_referentiel_autodiagnostic() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.modifie_le := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_referentiel_autodiagnostic_horodatage BEFORE UPDATE ON referentiel_autodiagnostic
  FOR EACH ROW EXECUTE FUNCTION horodater_referentiel_autodiagnostic();

-- ---------------------------------------------------------------------
-- 5. Évaluations
-- ---------------------------------------------------------------------
-- Clé composite pour les liens qui doivent rester dans la même entreprise.
CREATE TABLE autodiagnostic (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id    uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  reference        text        NOT NULL,
  referentiel_code text        NOT NULL,
  referentiel_titre text       NOT NULL,
  avertissement    text        NOT NULL,
  definition       jsonb       NOT NULL CHECK (definition_autodiagnostic_valide(definition)),
  site_id          uuid,
  interlocuteur    text        CHECK (interlocuteur IS NULL OR length(interlocuteur) <= 200),
  realise_le       date        NOT NULL DEFAULT CURRENT_DATE,
  statut           text        NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'terminee')),
  reponses         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reponses) = 'object'),
  commentaires     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(commentaires) = 'object'),
  resultat         jsonb,
  score_global     integer     CHECK (score_global BETWEEN 0 AND 100),
  niveau_libelle   text,
  terminee_le      timestamptz,
  conduit_par      uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  cree_le          timestamptz NOT NULL DEFAULT now(),
  modifie_le       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, reference),
  UNIQUE (id, entreprise_id),
  FOREIGN KEY (site_id, entreprise_id) REFERENCES site (id, entreprise_id) ON DELETE SET NULL (site_id),
  CHECK ((statut = 'en_cours' AND resultat IS NULL AND score_global IS NULL AND niveau_libelle IS NULL AND terminee_le IS NULL)
      OR (statut = 'terminee' AND resultat IS NOT NULL AND score_global IS NOT NULL AND niveau_libelle IS NOT NULL AND terminee_le IS NOT NULL))
);
CREATE INDEX idx_autodiagnostic_historique ON autodiagnostic (entreprise_id, referentiel_code, realise_le DESC);

-- Création : le questionnaire est COPIÉ du catalogue (le navigateur ne peut ni l'inventer ni l'altérer) ; référence AUD-AAAA-xxxxxxxx.
CREATE OR REPLACE FUNCTION preparer_autodiagnostic() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM referentiel_autodiagnostic WHERE code = NEW.referentiel_code AND actif;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Référentiel d''autodiagnostic inconnu ou désactivé.' USING ERRCODE = 'IF404';
  END IF;
  NEW.referentiel_titre := r.titre;
  NEW.avertissement := r.avertissement;
  NEW.definition := r.definition;
  NEW.statut := 'en_cours';
  NEW.reponses := '{}'::jsonb;
  NEW.commentaires := '{}'::jsonb;
  NEW.resultat := NULL; NEW.score_global := NULL; NEW.niveau_libelle := NULL; NEW.terminee_le := NULL;
  NEW.reference := 'AUD-' || to_char(coalesce(NEW.realise_le, current_date), 'YYYY') || '-' || upper(substr(NEW.id::text, 1, 8));
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_autodiagnostic_preparer BEFORE INSERT ON autodiagnostic
  FOR EACH ROW EXECUTE FUNCTION preparer_autodiagnostic();

-- Mise à jour : figé à la fin ; réponses et commentaires validés contre le questionnaire COPIÉ ; résultat réservé à
-- terminer_autodiagnostic() (drapeau transactionnel posé par la fonction seule).
CREATE OR REPLACE FUNCTION proteger_autodiagnostic() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids text[]; v_codes text[]; k text; v text;
  v_par_fonction boolean := coalesce(current_setting('app.autodiag_terminer', true), '') = 'on';
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.entreprise_id IS DISTINCT FROM OLD.entreprise_id
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.referentiel_code IS DISTINCT FROM OLD.referentiel_code
     OR NEW.referentiel_titre IS DISTINCT FROM OLD.referentiel_titre OR NEW.avertissement IS DISTINCT FROM OLD.avertissement
     OR NEW.definition IS DISTINCT FROM OLD.definition OR NEW.cree_le IS DISTINCT FROM OLD.cree_le THEN
    RAISE EXCEPTION 'Identité, référence et questionnaire d''une évaluation ne changent pas.' USING ERRCODE = 'IF409';
  END IF;

  IF OLD.statut = 'terminee' THEN
    RAISE EXCEPTION 'Évaluation terminée : définitive. Refaites un autodiagnostic pour suivre l''évolution.' USING ERRCODE = 'IF409';
  END IF;

  IF NEW.statut IS DISTINCT FROM OLD.statut OR NEW.resultat IS DISTINCT FROM OLD.resultat OR NEW.score_global IS DISTINCT FROM OLD.score_global
     OR NEW.niveau_libelle IS DISTINCT FROM OLD.niveau_libelle OR NEW.terminee_le IS DISTINCT FROM OLD.terminee_le THEN
    IF NOT v_par_fonction THEN
      RAISE EXCEPTION 'Le résultat est calculé par la base (terminer_autodiagnostic).' USING ERRCODE = 'IF403';
    END IF;
  END IF;

  SELECT array_agg(q->>'id') INTO v_ids
    FROM jsonb_array_elements(NEW.definition->'themes') t, jsonb_array_elements(t->'questions') q;
  SELECT array_agg(e->>'code') INTO v_codes FROM jsonb_array_elements(NEW.definition->'echelleReponses') e;
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.reponses) LOOP
    IF NOT (k = ANY (v_ids)) THEN RAISE EXCEPTION 'Question inconnue : %.', k USING ERRCODE = 'IF409'; END IF;
    IF NOT (v = ANY (v_codes)) THEN RAISE EXCEPTION 'Réponse inconnue pour la question % : %.', k, v USING ERRCODE = 'IF409'; END IF;
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.commentaires) LOOP
    IF NOT (k = ANY (v_ids)) THEN RAISE EXCEPTION 'Commentaire sur une question inconnue : %.', k USING ERRCODE = 'IF409'; END IF;
    IF length(v) > 1000 THEN RAISE EXCEPTION 'Commentaire trop long (1000 caractères).' USING ERRCODE = 'IF409'; END IF;
  END LOOP;
  NEW.modifie_le := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_autodiagnostic_proteger BEFORE UPDATE ON autodiagnostic
  FOR EACH ROW EXECUTE FUNCTION proteger_autodiagnostic();

-- Suppression : une évaluation terminée ne disparaît que par l'administrateur ; jamais si des actions en dépendent
-- (clé étrangère de autodiagnostic_action).
CREATE OR REPLACE FUNCTION proteger_suppression_autodiagnostic() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.statut = 'terminee' AND NOT (est_admin_plateforme_courant() OR current_setting('app.platform_admin', true) = 'true') THEN
    RAISE EXCEPTION 'Évaluation terminée : seul l''administrateur peut la supprimer.' USING ERRCODE = 'IF403';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER trg_autodiagnostic_suppression BEFORE DELETE ON autodiagnostic
  FOR EACH ROW EXECUTE FUNCTION proteger_suppression_autodiagnostic();

-- Terminer : toutes les questions répondues, résultat calculé ici, statut figé. Équipe IFECARM de l'entreprise active.
CREATE OR REPLACE FUNCTION terminer_autodiagnostic(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  a record; v_resultat jsonb; v_total integer; v_repondues integer;
BEGIN
  IF NOT est_consultant_ou_admin_courant() THEN
    RAISE EXCEPTION 'Réservé à l''équipe IFECARM.' USING ERRCODE = 'IF403';
  END IF;
  SELECT * INTO a FROM autodiagnostic
   WHERE id = p_id AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Évaluation introuvable.' USING ERRCODE = 'IF404'; END IF;
  IF a.statut = 'terminee' THEN RAISE EXCEPTION 'Évaluation déjà terminée.' USING ERRCODE = 'IF409'; END IF;

  SELECT count(*) INTO v_total FROM jsonb_array_elements(a.definition->'themes') t, jsonb_array_elements(t->'questions') q;
  SELECT count(*) INTO v_repondues FROM jsonb_object_keys(a.reponses);
  IF v_repondues < v_total THEN
    RAISE EXCEPTION '% question(s) sans réponse sur %.', v_total - v_repondues, v_total USING ERRCODE = 'IF409';
  END IF;

  v_resultat := calculer_resultat_autodiagnostic(a.definition, a.reponses);
  PERFORM set_config('app.autodiag_terminer', 'on', true);
  UPDATE autodiagnostic
     SET statut = 'terminee', resultat = v_resultat, score_global = (v_resultat->>'globalScore')::integer,
         niveau_libelle = v_resultat->'niveau'->>'libelle', terminee_le = now()
   WHERE id = a.id;
  PERFORM set_config('app.autodiag_terminer', 'off', true);
  RETURN v_resultat;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. Actions issues des écarts
-- ---------------------------------------------------------------------
CREATE TABLE autodiagnostic_action (
  autodiagnostic_id uuid NOT NULL,
  entreprise_id     uuid NOT NULL,
  question_id       text NOT NULL,
  action_id         uuid NOT NULL UNIQUE REFERENCES action_corrective(id) ON DELETE CASCADE,
  cree_le           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (autodiagnostic_id, question_id),
  -- Pas de CASCADE : supprimer une évaluation qui a des actions est refusé (NO ACTION, vérifié en fin d'instruction : la
  -- suppression d'une entreprise, qui supprime aussi ses actions, reste possible).
  FOREIGN KEY (autodiagnostic_id, entreprise_id) REFERENCES autodiagnostic (id, entreprise_id)
);

-- Le lien doit viser une question du questionnaire de l'évaluation TERMINÉE, et une action de la même entreprise
-- dont l'origine est cette évaluation.
CREATE OR REPLACE FUNCTION verifier_action_autodiagnostic() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM autodiagnostic WHERE id = NEW.autodiagnostic_id AND entreprise_id = NEW.entreprise_id;
  IF NOT FOUND OR a.statut <> 'terminee' THEN
    RAISE EXCEPTION 'Les actions se créent depuis une évaluation terminée.' USING ERRCODE = 'IF409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.definition->'themes') t, jsonb_array_elements(t->'questions') q WHERE q->>'id' = NEW.question_id) THEN
    RAISE EXCEPTION 'Question inconnue dans cette évaluation.' USING ERRCODE = 'IF409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM action_corrective ac WHERE ac.id = NEW.action_id AND ac.entreprise_id = NEW.entreprise_id
                   AND ac.origine_type = 'audit' AND ac.origine_id = NEW.autodiagnostic_id) THEN
    RAISE EXCEPTION 'L''action doit être une action d''origine audit rattachée à cette évaluation.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_autodiagnostic_action_verif BEFORE INSERT ON autodiagnostic_action
  FOR EACH ROW EXECUTE FUNCTION verifier_action_autodiagnostic();

-- Origine « audit » d'une action : évaluation terminée de la même entreprise (les règles « inspection » et
-- « déclaration » sont reprises à l'identique de 0035).
CREATE OR REPLACE FUNCTION verifier_origine_action_inspection() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.origine_type = 'inspection' THEN
    IF NEW.origine_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM non_conformite nc
         WHERE nc.id = NEW.origine_id AND nc.entreprise_id = NEW.entreprise_id) THEN
      RAISE EXCEPTION
        'Une action corrective d''origine inspection doit référencer (origine_id) une non-conformité de la même entreprise.';
    END IF;
  ELSIF NEW.origine_type = 'declaration' THEN
    IF NEW.origine_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM declaration d
         WHERE d.id = NEW.origine_id AND d.entreprise_id = NEW.entreprise_id) THEN
      RAISE EXCEPTION
        'Une action corrective d''origine déclaration doit référencer (origine_id) une déclaration de la même entreprise.';
    END IF;
  ELSIF NEW.origine_type = 'audit' THEN
    IF NEW.origine_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM autodiagnostic a
         WHERE a.id = NEW.origine_id AND a.entreprise_id = NEW.entreprise_id AND a.statut = 'terminee') THEN
      RAISE EXCEPTION
        'Une action corrective d''origine audit doit référencer (origine_id) un autodiagnostic terminé de la même entreprise.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 7. Vue : dernier résultat par référentiel (tableau de bord) avec le résultat précédent
-- ---------------------------------------------------------------------
CREATE VIEW v_autodiagnostic_dernier WITH (security_invoker = true) AS
SELECT id, entreprise_id, referentiel_code, referentiel_titre, score_global, niveau_libelle, realise_le, terminee_le, score_precedent
FROM (
  SELECT a.id, a.entreprise_id, a.referentiel_code, a.referentiel_titre, a.score_global, a.niveau_libelle, a.realise_le, a.terminee_le,
         row_number() OVER w AS rang,
         lead(a.score_global) OVER w AS score_precedent
  FROM autodiagnostic a
  WHERE a.statut = 'terminee'
  WINDOW w AS (PARTITION BY a.entreprise_id, a.referentiel_code ORDER BY a.realise_le DESC, a.terminee_le DESC)
) t
WHERE rang = 1;

-- ---------------------------------------------------------------------
-- 8. Droits et RLS (ENABLE sans FORCE)
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION preparer_autodiagnostic() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION proteger_autodiagnostic() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION proteger_suppression_autodiagnostic() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION verifier_action_autodiagnostic() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION verifier_origine_action_inspection() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION terminer_autodiagnostic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION terminer_autodiagnostic(uuid) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION definition_autodiagnostic_valide(jsonb) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION calculer_resultat_autodiagnostic(jsonb, jsonb) TO ifecarm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON referentiel_autodiagnostic TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON autodiagnostic             TO ifecarm_app;
GRANT SELECT, INSERT                 ON autodiagnostic_action      TO ifecarm_app;
GRANT SELECT                         ON v_autodiagnostic_dernier   TO ifecarm_app;

ALTER TABLE referentiel_autodiagnostic ENABLE ROW LEVEL SECURITY;
ALTER TABLE autodiagnostic             ENABLE ROW LEVEL SECURITY;
ALTER TABLE autodiagnostic_action      ENABLE ROW LEVEL SECURITY;

-- Catalogue : lu par l'équipe IFECARM, écrit par l'administrateur seulement (opération gerer_catalogue_autodiagnostic).
CREATE POLICY lecture_referentiel_autodiagnostic ON referentiel_autodiagnostic FOR SELECT
  USING (est_consultant_ou_admin_courant() OR current_setting('app.platform_admin', true) = 'true');
CREATE POLICY ecriture_referentiel_autodiagnostic ON referentiel_autodiagnostic FOR ALL
  USING (current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.platform_admin', true) = 'true');

-- Évaluations : équipe = tout dans l'entreprise active ; client (admin d'entreprise, responsable QHSE) = terminées seulement.
CREATE POLICY lecture_autodiagnostic ON autodiagnostic FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR (statut = 'terminee' AND est_responsable_registre_courant())));
CREATE POLICY ecriture_autodiagnostic ON autodiagnostic FOR ALL
  USING (est_consultant_ou_admin_courant() AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant() AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_autodiagnostic_action ON autodiagnostic_action FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));
CREATE POLICY ajout_autodiagnostic_action ON autodiagnostic_action FOR INSERT
  WITH CHECK (est_consultant_ou_admin_courant() AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
