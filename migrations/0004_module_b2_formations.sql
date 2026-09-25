-- =====================================================================
-- Plateforme QHSE IFECARM — module B2 : formations et attestations
-- PostgreSQL 15+
--
-- Basé sur module-b2-formations-schema.sql fourni, avec les corrections de
-- la revue de sécurité (même logique que migrations/0001_socle.sql) :
--   1. ENABLE ROW LEVEL SECURITY seul, jamais FORCE — FORCE casserait
--      l'exemption du propriétaire (ifecarm_migrate) sur laquelle repose
--      l'import du catalogue IFECARM par script de migration.
--   2. NULLIF(current_setting(...), '')::uuid partout, pas
--      current_setting(...)::uuid directement (piège du pool de connexions,
--      cf. migrations/0003_fix_guc_empty_string.sql).
--   3. ecriture_formation gagne l'échappatoire platform_admin qui manquait :
--      sans elle, personne — pas même admin_plateforme — ne peut jamais
--      écrire une ligne de catalogue partagé (entreprise_id NULL), alors que
--      la tâche l'exige explicitement.
--   4. verifier_attestation durci : search_path fixé (une fonction
--      SECURITY DEFINER sans search_path fixe est détournable), EXECUTE
--      révoqué de PUBLIC puis accordé au seul ifecarm_app, et c'est la
--      fonction elle-même qui enregistre la consultation dans
--      verification_attestation — ifecarm_app n'a AUCUN droit direct sur
--      cette table (ni SELECT, ni INSERT), réduisant sa surface
--      d'exposition (elle porte des adresses IP).
--
-- Décision actée : aucune échappatoire platform_admin sur session_formation,
-- participant, emargement, attestation, alerte_recyclage — délibéré, pas un
-- oubli. Un admin_plateforme gère la plateforme, pas les données personnelles
-- (émargements, notes, résultats d'aptitude) d'un salarié client. Un accès
-- support passe par acces_consultant (nominatif, limité dans le temps,
-- tracé — cf. socle), jamais par un bypass plateforme.
-- =====================================================================

-- =====================================================================
-- 1. CATALOGUE DES FORMATIONS
-- =====================================================================

CREATE TABLE formation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = formation du catalogue IFECARM, proposée à tous les clients.
  entreprise_id   uuid        REFERENCES entreprise(id) ON DELETE CASCADE,
  slug            text        NOT NULL,
  intitule        text        NOT NULL,
  domaine         text        NOT NULL,
  public_vise     text,
  prerequis       text,
  objectifs       text[],
  programme       text[],
  duree_jours     numeric(4,1) NOT NULL,
  duree_libelle   text,
  modalites       text[],       -- intra, inter, distanciel
  certification   text,
  -- Durée de validité de la certification délivrée. NULL = sans échéance.
  validite_mois   integer,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, slug)
);

CREATE INDEX idx_formation_domaine ON formation(domaine) WHERE actif;

-- =====================================================================
-- 2. SESSIONS
-- =====================================================================

CREATE TABLE session_formation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  formation_id    uuid        NOT NULL REFERENCES formation(id) ON DELETE RESTRICT,
  site_id         uuid        REFERENCES site(id) ON DELETE SET NULL,
  reference       text        NOT NULL,   -- ex. SST-2026-014
  date_debut      date        NOT NULL,
  date_fin        date        NOT NULL,
  lieu            text,
  -- Formateur : un utilisateur de la plateforme, ou un nom libre pour un
  -- intervenant extérieur.
  formateur_id    uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  formateur_nom   text,
  places_max      integer,
  statut          text        NOT NULL DEFAULT 'planifiee'
                  CHECK (statut IN ('planifiee','confirmee','realisee','annulee')),
  commentaire     text,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, reference),
  CHECK (date_fin >= date_debut)
);

CREATE INDEX idx_session_entreprise_date ON session_formation(entreprise_id, date_debut DESC);
CREATE INDEX idx_session_formation ON session_formation(formation_id);

-- =====================================================================
-- 3. PARTICIPANTS
-- Un participant est un salarié inscrit à une session. Le résultat et
-- l'émargement se saisissent ici.
-- =====================================================================

CREATE TABLE participant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  session_id      uuid        NOT NULL REFERENCES session_formation(id) ON DELETE CASCADE,
  salarie_id      uuid        NOT NULL REFERENCES salarie(id) ON DELETE RESTRICT,
  statut          text        NOT NULL DEFAULT 'inscrit'
                  CHECK (statut IN ('inscrit','present','absent','abandon')),
  resultat        text        CHECK (resultat IN ('apte','inapte','non_evalue')),
  note            numeric(4,1),
  commentaire     text,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, salarie_id)
);

CREATE INDEX idx_participant_salarie ON participant(salarie_id);

-- Émargement par demi-journée : c'est ce que vérifie un contrôle, et ce
-- qu'exige un organisme financeur.
CREATE TABLE emargement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  participant_id  uuid        NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  jour            date        NOT NULL,
  demi_journee    text        NOT NULL CHECK (demi_journee IN ('matin','apres_midi')),
  present         boolean     NOT NULL DEFAULT false,
  -- Signature manuscrite capturée sur tablette, stockée comme fichier.
  signature_id    uuid        REFERENCES fichier(id) ON DELETE SET NULL,
  signe_le        timestamptz,
  UNIQUE (participant_id, jour, demi_journee)
);

-- =====================================================================
-- 4. ATTESTATIONS
--
-- Une attestation est émise à partir d'un participant déclaré apte.
-- Le code de vérification est public : il figure dans le QR code et
-- permet à un tiers de contrôler l'authenticité sans compte.
-- =====================================================================

CREATE TABLE attestation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  participant_id  uuid        NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  -- Code public, court et non devinable, porté par le QR code.
  code_verification text      NOT NULL UNIQUE,
  -- Données figées à l'émission : une attestation ne doit pas changer
  -- si le salarié est renommé ou la formation modifiée par la suite.
  nom_salarie     text        NOT NULL,
  prenom_salarie  text        NOT NULL,
  intitule_formation text     NOT NULL,
  nom_entreprise  text        NOT NULL,
  date_debut      date        NOT NULL,
  date_fin        date        NOT NULL,
  duree_libelle   text,
  formateur       text,
  emise_le        date        NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = attestation sans échéance.
  expire_le       date,
  statut          text        NOT NULL DEFAULT 'valide'
                  CHECK (statut IN ('valide','annulee')),
  motif_annulation text,
  annulee_le      timestamptz,
  pdf_id          uuid        REFERENCES fichier(id) ON DELETE SET NULL,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attestation_code ON attestation(code_verification);
CREATE INDEX idx_attestation_expiration ON attestation(expire_le)
  WHERE statut = 'valide' AND expire_le IS NOT NULL;

-- Consultations de la page publique de vérification. Utile comme preuve
-- d'usage, et pour détecter un code testé en masse. AUCUN RLS, AUCUN GRANT
-- pour ifecarm_app sur cette table (cf. section 7) : elle porte des
-- adresses IP, seule la fonction verifier_attestation (SECURITY DEFINER)
-- peut y écrire.
CREATE TABLE verification_attestation (
  id              bigserial PRIMARY KEY,
  code_verification text      NOT NULL,
  trouvee         boolean     NOT NULL,
  adresse_ip      inet,
  consultee_le    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 5. ALERTES DE RECYCLAGE
--
-- Une ligne par échéance et par jalon (90, 30, 7 jours). La contrainte
-- d'unicité garantit qu'une alerte n'est jamais envoyée deux fois, même
-- si le travailleur de notification est relancé.
-- =====================================================================

CREATE TABLE alerte_recyclage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  attestation_id  uuid        NOT NULL REFERENCES attestation(id) ON DELETE CASCADE,
  jalon_jours     integer     NOT NULL CHECK (jalon_jours IN (90, 30, 7)),
  notification_id uuid        REFERENCES notification(id) ON DELETE SET NULL,
  declenchee_le   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attestation_id, jalon_jours)
);

-- =====================================================================
-- 6. HORODATAGE
-- =====================================================================

CREATE TRIGGER trg_formation_modifie BEFORE UPDATE ON formation
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();
CREATE TRIGGER trg_session_modifie BEFORE UPDATE ON session_formation
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- =====================================================================
-- 7. RÔLES POSTGRES ET DROITS
-- =====================================================================

GRANT SELECT, INSERT, UPDATE         ON formation             TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON session_formation      TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON participant            TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON emargement             TO ifecarm_app;
-- attestation : jamais de DELETE — "l'attestation reste en base" même
-- annulée (statut + motif_annulation), exigence explicite de la tâche.
GRANT SELECT, INSERT, UPDATE         ON attestation            TO ifecarm_app;
-- alerte_recyclage : déposée une fois par le job quotidien, jamais modifiée
-- ni supprimée (chaque ligne est un jalon déclenché, horodaté).
GRANT SELECT, INSERT                 ON alerte_recyclage       TO ifecarm_app;
-- verification_attestation : AUCUN GRANT — cf. section 4 et section 8.

-- =====================================================================
-- 8. CLOISONNEMENT
--
-- Comme pour le socle : USING filtre les lectures, WITH CHECK empêche
-- d'écrire une ligne au nom d'une autre entreprise. ENABLE seul, jamais
-- FORCE (cf. en-tête de ce fichier).
--
-- formation est le cas particulier : les lignes du catalogue IFECARM
-- (entreprise_id NULL) sont lisibles par tous, modifiables uniquement par
-- admin_plateforme (via withPlatformAdmin, opération 'gerer_catalogue_formation').
-- =====================================================================

ALTER TABLE formation         ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_formation ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant       ENABLE ROW LEVEL SECURITY;
ALTER TABLE emargement        ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestation       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerte_recyclage  ENABLE ROW LEVEL SECURITY;
-- volontairement PAS de ENABLE/FORCE sur verification_attestation : sans
-- aucun GRANT pour ifecarm_app, le RLS n'y ajouterait rien (une table sans
-- privilège du tout est déjà totalement fermée à ce rôle).

CREATE POLICY lecture_formation ON formation FOR SELECT
  USING (entreprise_id IS NULL
         OR entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY ecriture_formation ON formation FOR ALL
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_session ON session_formation FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_participant ON participant FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_emargement ON emargement FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_attestation ON attestation FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_alerte ON alerte_recyclage FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- =====================================================================
-- 9. VÉRIFICATION PUBLIQUE D'ATTESTATION
--
-- Appelée depuis une route publique, sans authentification, donc sans
-- app.entreprise_id ni app.utilisateur_id positionnés. SECURITY DEFINER :
-- s'exécute avec les droits de son PROPRIÉTAIRE (ifecarm_migrate, exempté
-- du RLS), pour lire à travers toutes les entreprises et ne renvoyer que
-- les colonnes affichables. C'est aussi la fonction elle-même — pas la
-- route applicative — qui journalise la consultation, précisément pour
-- qu'ifecarm_app n'ait besoin d'AUCUN droit sur verification_attestation.
-- =====================================================================

CREATE OR REPLACE FUNCTION verifier_attestation(p_code text, p_adresse_ip inet)
RETURNS TABLE (
  nom_salarie text, prenom_salarie text, intitule_formation text,
  nom_entreprise text, date_fin date, expire_le date, statut text
)
LANGUAGE plpgsql
SECURITY DEFINER
-- Une fonction SECURITY DEFINER sans search_path fixe est détournable
-- (une fonction/table de même nom créée plus tôt dans le search_path de
-- l'appelant pourrait être exécutée à la place de celle voulue).
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_trouvee boolean;
BEGIN
  v_trouvee := EXISTS (SELECT 1 FROM attestation a WHERE a.code_verification = p_code);

  INSERT INTO verification_attestation (code_verification, trouvee, adresse_ip)
  VALUES (p_code, v_trouvee, p_adresse_ip);

  RETURN QUERY
  SELECT a.nom_salarie, a.prenom_salarie, a.intitule_formation,
         a.nom_entreprise, a.date_fin, a.expire_le, a.statut
  FROM attestation a
  WHERE a.code_verification = p_code;
END;
$$;

-- PostgreSQL accorde EXECUTE à PUBLIC par défaut sur une fonction nouvellement
-- créée : on le révoque explicitement avant de n'accorder qu'à ifecarm_app.
REVOKE EXECUTE ON FUNCTION verifier_attestation(text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verifier_attestation(text, inet) TO ifecarm_app;
