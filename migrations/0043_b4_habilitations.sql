-- =====================================================================
-- B4 habilitations (06/10/2026). AUCUN schéma n'existait (CLAUDE.md le disait
-- à tort) : celui-ci est écrit d'emblée avec le niveau d'exigence de B2/B3.
-- Décisions de l'utilisateur :
--   PÉRIMÈTRE  Habilitations individuelles + matrice « qui est habilité à
--              quoi » + alertes de renouvellement (90, 30, 7 jours, échéance).
--   TYPES      Catalogue IFECARM (administrateur) + types propres à un client
--              (consultant), comme les formations de B2.
--   LIEN B2    Une habilitation peut référencer une attestation de formation
--              (facultatif) ; la date de validité est alors reprise de
--              l'attestation à la saisie. Supprimer l'attestation ne supprime
--              pas l'habilitation.
--   DROITS     Écriture : équipe IFECARM seulement. Lecture : équipe, admin
--              d'entreprise et responsable QHSE (toute l'entreprise),
--              responsable de site (salariés de son site). Aucun autre
--              utilisateur du client. Aucune échappatoire platform_admin sur
--              habilitation (donnée personnelle) ; le catalogue, lui, est
--              géré par l'administrateur (opération gerer_catalogue_habilitation).
-- Modèle :
--   - Une ligne = un titre délivré. Renouveler = créer une NOUVELLE ligne
--     (renouvelle_id) et marquer l'ancienne « remplacee » : l'historique des
--     titres est conservé, la matrice lit le titre en cours.
--   - Statut saisi : active | suspendue | retiree | remplacee. L'état affiché
--     (valide / à renouveler / expirée…) est CALCULÉ à partir de la date de
--     validité (fonction etat_habilitation, vue v_habilitation_etat).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Types d'habilitation
-- ---------------------------------------------------------------------
CREATE TABLE type_habilitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = catalogue IFECARM, proposé à tous les clients.
  entreprise_id uuid        REFERENCES entreprise(id) ON DELETE CASCADE,
  code          text        NOT NULL CHECK (char_length(btrim(code)) BETWEEN 1 AND 40),
  intitule      text        NOT NULL CHECK (char_length(btrim(intitule)) BETWEEN 1 AND 200),
  domaine       text        NOT NULL
                CHECK (domaine IN ('electrique', 'conduite_levage', 'hauteur', 'secourisme', 'incendie', 'autre')),
  referentiel   text        CHECK (referentiel IS NULL OR char_length(referentiel) <= 200),
  -- Durée de validité habituelle, indicative : reprise comme valeur par défaut à la saisie.
  validite_mois integer     CHECK (validite_mois IS NULL OR validite_mois BETWEEN 1 AND 240),
  actif         boolean     NOT NULL DEFAULT true,
  cree_le       timestamptz NOT NULL DEFAULT now(),
  modifie_le    timestamptz NOT NULL DEFAULT now()
);

-- NULL ≠ NULL : sans index partiel, le catalogue pourrait porter deux fois le même code (cf. B2, 0029).
CREATE UNIQUE INDEX uq_type_habilitation_catalogue ON type_habilitation (lower(code)) WHERE entreprise_id IS NULL;
CREATE UNIQUE INDEX uq_type_habilitation_entreprise ON type_habilitation (entreprise_id, lower(code)) WHERE entreprise_id IS NOT NULL;

-- Un type client ne peut pas reprendre le code d'un type du catalogue (matrice ambiguë) ; son entreprise ne change jamais.
CREATE OR REPLACE FUNCTION verifier_type_habilitation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.entreprise_id IS DISTINCT FROM OLD.entreprise_id THEN
    RAISE EXCEPTION 'L''entreprise d''un type d''habilitation ne change pas.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.entreprise_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM type_habilitation t WHERE t.entreprise_id IS NULL AND lower(t.code) = lower(NEW.code)) THEN
    RAISE EXCEPTION 'Ce code existe déjà dans le catalogue IFECARM.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION verifier_type_habilitation() FROM PUBLIC;
CREATE TRIGGER trg_type_habilitation_verif BEFORE INSERT OR UPDATE ON type_habilitation
  FOR EACH ROW EXECUTE FUNCTION verifier_type_habilitation();
CREATE TRIGGER trg_type_habilitation_modifie BEFORE UPDATE ON type_habilitation
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- ---------------------------------------------------------------------
-- 2. Habilitations
-- ---------------------------------------------------------------------
-- attestation porte déjà UNIQUE (id, entreprise_id) (0006) : clé de la référence composite ci-dessous.

CREATE TABLE habilitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  salarie_id    uuid        NOT NULL,
  -- NO ACTION (pas RESTRICT) : la suppression d'une entreprise emporte types et habilitations dans la même instruction.
  type_id       uuid        NOT NULL REFERENCES type_habilitation(id),
  -- Mention, indice ou catégorie du titre (B2V, catégorie 3, H0V…) : distingue deux titres du même type.
  niveau        text        CHECK (niveau IS NULL OR char_length(btrim(niveau)) BETWEEN 1 AND 100),
  reference_titre text      CHECK (reference_titre IS NULL OR char_length(reference_titre) <= 200),
  delivre_par   text        CHECK (delivre_par IS NULL OR char_length(delivre_par) <= 200),
  date_delivrance date      NOT NULL,
  -- NULL = sans échéance.
  date_validite date,
  statut        text        NOT NULL DEFAULT 'active'
                CHECK (statut IN ('active', 'suspendue', 'retiree', 'remplacee')),
  motif         text        CHECK (motif IS NULL OR char_length(motif) <= 1000),
  renouvelle_id uuid,
  attestation_id uuid,
  fichier_id    uuid,
  commentaire   text        CHECK (commentaire IS NULL OR char_length(commentaire) <= 2000),
  cree_par      uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  cree_le       timestamptz NOT NULL DEFAULT now(),
  modifie_le    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, entreprise_id),
  FOREIGN KEY (salarie_id, entreprise_id) REFERENCES salarie (id, entreprise_id) ON DELETE CASCADE,
  FOREIGN KEY (renouvelle_id, entreprise_id) REFERENCES habilitation (id, entreprise_id) ON DELETE SET NULL (renouvelle_id),
  FOREIGN KEY (attestation_id, entreprise_id) REFERENCES attestation (id, entreprise_id) ON DELETE SET NULL (attestation_id),
  FOREIGN KEY (fichier_id, entreprise_id) REFERENCES fichier (id, entreprise_id) ON DELETE SET NULL (fichier_id),
  CHECK (date_validite IS NULL OR date_validite >= date_delivrance),
  CHECK (statut NOT IN ('suspendue', 'retiree') OR NULLIF(btrim(coalesce(motif, '')), '') IS NOT NULL)
);

-- Pas deux titres en cours pour le même salarié, le même type et le même niveau.
CREATE UNIQUE INDEX uq_habilitation_en_cours ON habilitation (salarie_id, type_id, (coalesce(lower(btrim(niveau)), '')))
  WHERE statut IN ('active', 'suspendue');
CREATE INDEX idx_habilitation_salarie ON habilitation (salarie_id);
CREATE INDEX idx_habilitation_echeance ON habilitation (entreprise_id, date_validite) WHERE statut = 'active' AND date_validite IS NOT NULL;
CREATE INDEX idx_habilitation_type ON habilitation (type_id);

CREATE TRIGGER trg_habilitation_modifie BEFORE UPDATE ON habilitation
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- Création : auteur posé par le serveur ; type du catalogue ou de la même entreprise et actif ; attestation
-- valide du MÊME salarié ; renouvellement du même salarié et du même type, titre précédent déjà « remplacee ».
CREATE OR REPLACE FUNCTION preparer_habilitation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ancien record;
BEGIN
  NEW.cree_par := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  IF NEW.fichier_id IS NOT NULL THEN
    RAISE EXCEPTION 'Le justificatif se joint après la création de l''habilitation.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut <> 'active' THEN
    RAISE EXCEPTION 'Une habilitation se crée « active ».' USING ERRCODE = 'IF409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM type_habilitation t WHERE t.id = NEW.type_id AND t.actif
                 AND (t.entreprise_id IS NULL OR t.entreprise_id = NEW.entreprise_id)) THEN
    RAISE EXCEPTION 'Type d''habilitation inconnu, inactif, ou d''une autre entreprise.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.attestation_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM attestation a JOIN participant p ON p.id = a.participant_id
       WHERE a.id = NEW.attestation_id AND a.entreprise_id = NEW.entreprise_id AND a.statut = 'valide' AND p.salarie_id = NEW.salarie_id) THEN
    RAISE EXCEPTION 'L''attestation doit être valide et délivrée à ce salarié.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.renouvelle_id IS NOT NULL THEN
    SELECT h.salarie_id, h.type_id, h.statut INTO v_ancien FROM habilitation h WHERE h.id = NEW.renouvelle_id AND h.entreprise_id = NEW.entreprise_id;
    IF NOT FOUND OR v_ancien.salarie_id <> NEW.salarie_id OR v_ancien.type_id <> NEW.type_id THEN
      RAISE EXCEPTION 'Un renouvellement concerne le même salarié et le même type d''habilitation.' USING ERRCODE = 'IF409';
    END IF;
    IF v_ancien.statut <> 'remplacee' THEN
      RAISE EXCEPTION 'Le titre précédent doit d''abord être marqué « remplacée ».' USING ERRCODE = 'IF409';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION preparer_habilitation() FROM PUBLIC;
CREATE TRIGGER trg_habilitation_preparer BEFORE INSERT ON habilitation
  FOR EACH ROW EXECUTE FUNCTION preparer_habilitation();

-- Modification : identité figée (entreprise, salarié, type, création, renouvellement) ; « retiree » et « remplacee »
-- définitifs ; transitions contrôlées ; justificatif = un fichier de CETTE habilitation. Exception : la suppression
-- d'un compte, d'une attestation, d'un justificatif ou du titre précédent ne fait que mettre une référence à NULL.
CREATE OR REPLACE FUNCTION proteger_habilitation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'cree_par' - 'attestation_id' - 'fichier_id' - 'renouvelle_id' - 'modifie_le')
       = (to_jsonb(OLD) - 'cree_par' - 'attestation_id' - 'fichier_id' - 'renouvelle_id' - 'modifie_le')
     AND (NEW.cree_par IS NULL OR NEW.cree_par IS NOT DISTINCT FROM OLD.cree_par)
     AND (NEW.attestation_id IS NULL OR NEW.attestation_id IS NOT DISTINCT FROM OLD.attestation_id)
     AND (NEW.fichier_id IS NULL OR NEW.fichier_id IS NOT DISTINCT FROM OLD.fichier_id)
     AND (NEW.renouvelle_id IS NULL OR NEW.renouvelle_id IS NOT DISTINCT FROM OLD.renouvelle_id) THEN
    RETURN NEW;
  END IF;

  IF OLD.statut IN ('retiree', 'remplacee') THEN
    RAISE EXCEPTION 'Une habilitation retirée ou remplacée est figée.' USING ERRCODE = 'IF409';
  END IF;
  IF (NEW.id, NEW.entreprise_id, NEW.salarie_id, NEW.type_id, NEW.cree_le, NEW.renouvelle_id, NEW.cree_par)
     IS DISTINCT FROM (OLD.id, OLD.entreprise_id, OLD.salarie_id, OLD.type_id, OLD.cree_le, OLD.renouvelle_id, OLD.cree_par) THEN
    RAISE EXCEPTION 'Le salarié, le type et l''origine d''une habilitation ne changent jamais : retirez-la et créez-en une autre.' USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut <> OLD.statut AND NOT (OLD.statut = 'active' AND NEW.statut IN ('suspendue', 'retiree', 'remplacee')
                                       OR OLD.statut = 'suspendue' AND NEW.statut IN ('active', 'retiree', 'remplacee')) THEN
    RAISE EXCEPTION 'Transition de statut impossible : % → %.', OLD.statut, NEW.statut USING ERRCODE = 'IF409';
  END IF;
  IF NEW.statut = 'active' THEN NEW.motif := NULL; END IF;
  IF NEW.fichier_id IS DISTINCT FROM OLD.fichier_id AND NEW.fichier_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fichier f WHERE f.id = NEW.fichier_id AND f.entreprise_id = NEW.entreprise_id
         AND f.objet_type = 'habilitation' AND f.objet_id = NEW.id) THEN
    RAISE EXCEPTION 'Le justificatif doit être un fichier rattaché à cette habilitation.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION proteger_habilitation() FROM PUBLIC;
CREATE TRIGGER trg_habilitation_figee BEFORE UPDATE ON habilitation
  FOR EACH ROW EXECUTE FUNCTION proteger_habilitation();

-- Un titre « remplacee » a forcément un successeur : vérifié à la fin de la transaction (le service marque l'ancien
-- puis insère le nouveau dans la même transaction). Supprimer le successeur d'un titre remplacé est refusé de la même
-- façon, sauf si l'ancien titre disparaît dans la même transaction (suppression d'un salarié, d'une entreprise).
CREATE OR REPLACE FUNCTION verifier_successeur_habilitation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.renouvelle_id ELSE NEW.id END;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'DELETE' AND NEW.statut <> 'remplacee' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM habilitation h WHERE h.id = v_id AND h.statut = 'remplacee')
     AND NOT EXISTS (SELECT 1 FROM habilitation h WHERE h.renouvelle_id = v_id) THEN
    RAISE EXCEPTION 'Une habilitation remplacée doit avoir un titre qui la remplace.' USING ERRCODE = 'IF409';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION verifier_successeur_habilitation() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_habilitation_successeur AFTER INSERT OR UPDATE OF statut OR DELETE ON habilitation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verifier_successeur_habilitation();

-- ---------------------------------------------------------------------
-- 3. État calculé et matrice
-- ---------------------------------------------------------------------
-- valide : échéance lointaine ou sans échéance ; a_renouveler : échéance dans 90 jours ou moins ; expiree : dépassée.
-- Les statuts saisis suspendue / retiree / remplacee l'emportent.
CREATE OR REPLACE FUNCTION etat_habilitation(p_statut text, p_validite date) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_statut <> 'active' THEN p_statut
    WHEN p_validite IS NULL THEN 'valide'
    WHEN p_validite < CURRENT_DATE THEN 'expiree'
    WHEN p_validite - CURRENT_DATE <= 90 THEN 'a_renouveler'
    ELSE 'valide' END
$$;

CREATE VIEW v_habilitation_etat
WITH (security_invoker = true) AS
SELECT h.id, h.entreprise_id, h.salarie_id, h.type_id, h.niveau, h.date_delivrance, h.date_validite, h.statut,
       etat_habilitation(h.statut, h.date_validite) AS etat,
       CASE WHEN h.date_validite IS NULL THEN NULL ELSE h.date_validite - CURRENT_DATE END AS jours_restants
FROM habilitation h;

-- ---------------------------------------------------------------------
-- 4. Alertes de renouvellement (même schéma que alerte_recyclage de B2 et relance_action de B3)
-- ---------------------------------------------------------------------
CREATE TABLE alerte_habilitation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  habilitation_id uuid        NOT NULL,
  -- 0 = échéance atteinte ou dépassée.
  jalon_jours     integer     NOT NULL CHECK (jalon_jours IN (90, 30, 7, 0)),
  notification_id uuid        REFERENCES notification(id) ON DELETE SET NULL,
  declenchee_le   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habilitation_id, jalon_jours),
  FOREIGN KEY (habilitation_id, entreprise_id) REFERENCES habilitation (id, entreprise_id) ON DELETE CASCADE
);

-- Le responsable de site d'un salarié : rôle « responsable_site » sur le site du salarié.
CREATE OR REPLACE FUNCTION est_responsable_du_salarie_courant(p_salarie uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM salarie s
    JOIN role_utilisateur r ON r.site_id = s.site_id AND r.role = 'responsable_site'
    JOIN utilisateur u ON u.id = r.utilisateur_id
    WHERE s.id = p_salarie AND s.site_id IS NOT NULL
      AND r.utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
      AND u.actif AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
$$;
REVOKE EXECUTE ON FUNCTION est_responsable_du_salarie_courant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION est_responsable_du_salarie_courant(uuid) TO ifecarm_app;

-- Alertes : une par habilitation et par exécution, au jalon le plus avancé atteint (90, 30, 7 jours, échéance).
-- Titres « active » seulement, de salariés en poste, d'entreprises actives et non internes. Destinataires :
-- admin d'entreprise, responsable QHSE, et responsable du site du salarié. E-mails mis en file (notification,
-- en_attente) : l'envoi attend le fournisseur d'e-mail.
CREATE OR REPLACE FUNCTION alerter_habilitations(p_entreprise uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_h record;
  v_dest record;
  v_alerte uuid;
  v_premier uuid;
  v_notif uuid;
  v_jalon integer;
  v_reste integer;
  v_sujet text;
  v_corps text;
  v_titre text;
  v_nb integer := 0;
BEGIN
  FOR v_h IN
    SELECT h.id, h.entreprise_id, h.date_validite, h.niveau, s.prenom, s.nom, s.site_id, t.intitule
    FROM habilitation h
    JOIN salarie s ON s.id = h.salarie_id
    JOIN type_habilitation t ON t.id = h.type_id
    JOIN entreprise e ON e.id = h.entreprise_id
    WHERE h.statut = 'active' AND h.date_validite IS NOT NULL
      AND h.date_validite - current_date <= 90
      AND s.actif AND (s.date_sortie IS NULL OR s.date_sortie >= current_date)
      AND NOT e.interne AND e.desactive_le IS NULL
      AND (p_entreprise IS NULL OR h.entreprise_id = p_entreprise)
    ORDER BY h.entreprise_id, h.date_validite, h.id
  LOOP
    v_reste := v_h.date_validite - current_date;
    v_jalon := CASE WHEN v_reste <= 0 THEN 0 WHEN v_reste <= 7 THEN 7 WHEN v_reste <= 30 THEN 30 ELSE 90 END;

    INSERT INTO alerte_habilitation (entreprise_id, habilitation_id, jalon_jours)
    VALUES (v_h.entreprise_id, v_h.id, v_jalon)
    ON CONFLICT (habilitation_id, jalon_jours) DO NOTHING
    RETURNING id INTO v_alerte;
    CONTINUE WHEN v_alerte IS NULL;

    v_titre := v_h.intitule || CASE WHEN v_h.niveau IS NULL THEN '' ELSE ' ' || v_h.niveau END;
    IF v_reste > 0 THEN
      v_sujet := 'Habilitation à renouveler — ' || v_h.prenom || ' ' || v_h.nom;
      v_corps := 'L''habilitation « ' || v_titre || ' » de ' || v_h.prenom || ' ' || v_h.nom || ' arrive à échéance le '
                 || to_char(v_h.date_validite, 'DD/MM/YYYY') || ' (dans ' || v_reste || ' jour' || CASE WHEN v_reste > 1 THEN 's' ELSE '' END || ').';
    ELSE
      v_sujet := 'Habilitation échue — ' || v_h.prenom || ' ' || v_h.nom;
      v_corps := 'L''habilitation « ' || v_titre || ' » de ' || v_h.prenom || ' ' || v_h.nom || ' est échue depuis le '
                 || to_char(v_h.date_validite, 'DD/MM/YYYY') || '.';
    END IF;

    v_premier := NULL;
    FOR v_dest IN
      SELECT DISTINCT lower(u.email::text) AS email
      FROM utilisateur u
      WHERE u.actif AND u.entreprise_id = v_h.entreprise_id
        AND (EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role IN ('admin_entreprise', 'responsable_qhse'))
             OR (v_h.site_id IS NOT NULL AND EXISTS (SELECT 1 FROM role_utilisateur r WHERE r.utilisateur_id = u.id AND r.role = 'responsable_site' AND r.site_id = v_h.site_id)))
      ORDER BY 1
    LOOP
      INSERT INTO notification (entreprise_id, canal, destinataire, sujet, corps, module)
      VALUES (v_h.entreprise_id, 'email', v_dest.email, v_sujet, v_corps, 'habilitations')
      RETURNING id INTO v_notif;
      v_premier := coalesce(v_premier, v_notif);
    END LOOP;

    UPDATE alerte_habilitation SET notification_id = v_premier WHERE id = v_alerte;
    v_nb := v_nb + 1;
  END LOOP;
  RETURN v_nb;
END;
$$;
REVOKE EXECUTE ON FUNCTION alerter_habilitations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerter_habilitations(uuid) TO ifecarm_app;

-- ---------------------------------------------------------------------
-- 5. Droits et cloisonnement
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON type_habilitation   TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON habilitation        TO ifecarm_app;
GRANT SELECT                         ON alerte_habilitation TO ifecarm_app;
GRANT SELECT                         ON v_habilitation_etat TO ifecarm_app;
GRANT EXECUTE ON FUNCTION etat_habilitation(text, date) TO ifecarm_app;

ALTER TABLE type_habilitation   ENABLE ROW LEVEL SECURITY;
ALTER TABLE habilitation        ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerte_habilitation ENABLE ROW LEVEL SECURITY;

-- Catalogue lisible de tous ; modifiable par l'administrateur seulement ; type propre à une entreprise
-- modifiable par l'équipe IFECARM dans cette entreprise.
CREATE POLICY lecture_type_habilitation ON type_habilitation FOR SELECT
  USING (entreprise_id IS NULL OR entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);
CREATE POLICY ecriture_type_habilitation ON type_habilitation FOR ALL
  USING ((est_consultant_ou_admin_courant()
          AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK ((est_consultant_ou_admin_courant()
          AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
         OR current_setting('app.platform_admin', true) = 'true');

CREATE POLICY lecture_habilitation ON habilitation FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant()
              OR est_responsable_registre_courant()
              OR est_responsable_du_salarie_courant(salarie_id)));
CREATE POLICY ecriture_habilitation ON habilitation FOR ALL
  USING (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (est_consultant_ou_admin_courant()
         AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY lecture_alerte_habilitation ON alerte_habilitation FOR SELECT
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         AND (est_consultant_ou_admin_courant() OR est_responsable_registre_courant()));

-- ---------------------------------------------------------------------
-- 6. Fichiers : le justificatif d'une habilitation suit la visibilité de l'habilitation (même principe que 0038)
-- ---------------------------------------------------------------------
DROP POLICY lecture_fichier ON fichier;
DROP POLICY ajout_fichier ON fichier;
DROP POLICY maj_fichier ON fichier;
DROP POLICY suppression_fichier ON fichier;

-- Types d'objet protégés : leurs fichiers suivent l'objet, sans échappatoire platform_admin.
CREATE POLICY lecture_fichier ON fichier FOR SELECT
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
     AND (objet_type IS DISTINCT FROM 'declaration' OR EXISTS (SELECT 1 FROM declaration d WHERE d.id = fichier.objet_id))
     AND (objet_type IS DISTINCT FROM 'habilitation' OR EXISTS (SELECT 1 FROM habilitation h WHERE h.id = fichier.objet_id)))
    OR (current_setting('app.platform_admin', true) = 'true' AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
  );

CREATE POLICY ajout_fichier ON fichier FOR INSERT
  WITH CHECK (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
     AND (objet_type IS DISTINCT FROM 'habilitation' OR est_consultant_ou_admin_courant()))
    OR (current_setting('app.platform_admin', true) = 'true' AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
  );

CREATE POLICY maj_fichier ON fichier FOR UPDATE
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
    OR (current_setting('app.platform_admin', true) = 'true' AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
  )
  WITH CHECK (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
    OR (current_setting('app.platform_admin', true) = 'true' AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
  );

CREATE POLICY suppression_fichier ON fichier FOR DELETE
  USING (
    (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
     AND (coalesce(objet_type, '') NOT IN ('declaration', 'habilitation') OR est_consultant_ou_admin_courant()))
    OR (current_setting('app.platform_admin', true) = 'true' AND coalesce(objet_type, '') NOT IN ('declaration', 'habilitation'))
  );
