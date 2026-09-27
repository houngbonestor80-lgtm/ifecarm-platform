-- =====================================================================
-- Plateforme QHSE IFECARM — module B3 : registre de sécurité numérique
-- PostgreSQL 15+
--
-- Basé sur module-b3-registre-schema.sql fourni (déjà conforme aux
-- conventions du socle : ENABLE sans FORCE, NULLIF partout, aucune
-- échappatoire platform_admin), avec deux corrections BLOQUANTES issues de
-- la revue :
--
--   1. v_declaration_mensuelle recréée avec WITH (security_invoker = true).
--      Depuis PostgreSQL 15, une vue s'exécute par défaut avec les droits de
--      son PROPRIÉTAIRE (ifecarm_migrate) — qui est exempté du RLS puisqu'on
--      a retiré FORCE. Sans ce correctif, la vue aurait renvoyé les
--      déclarations de TOUTES les entreprises, quel que soit le rôle qui
--      l'interroge. security_invoker=true fait exécuter la vue avec les
--      droits du rôle APPELANT (ifecarm_app), qui reste soumis au RLS de
--      la table declaration sous-jacente.
--   2. generer_reference_declaration() : compteur atomique par
--      (entreprise_id, annee) via INSERT ... ON CONFLICT DO UPDATE — jamais
--      un SELECT max(...) + 1, qui produirait la même référence sous deux
--      synchronisations concurrentes.
--
-- Le point sur la génération de référence à l'insertion (pas à la
-- qualification, malgré le commentaire d'origine) et l'idempotence du rejeu
-- de synchronisation (ON CONFLICT ... DO UPDATE ... RETURNING id, pas
-- DO NOTHING qui ne renvoie rien) sont implémentés côté application, dans
-- src/registre/declarations.ts — la contrainte UNIQUE (entreprise_id,
-- cle_client) ci-dessous est ce qui les rend possibles.
-- =====================================================================

-- =====================================================================
-- 0. COMPTEUR DE RÉFÉRENCES (atomique, par entreprise et par année)
-- =====================================================================

CREATE TABLE compteur_reference_declaration (
  entreprise_id   uuid    NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  annee           integer NOT NULL,
  valeur          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (entreprise_id, annee)
);

ALTER TABLE compteur_reference_declaration ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloisonnement_compteur_reference ON compteur_reference_declaration FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON compteur_reference_declaration TO ifecarm_app;

-- Pas SECURITY DEFINER : s'exécute avec les droits de l'appelant
-- (ifecarm_app), donc doit être appelée DEPUIS un contexte withTenant où
-- app.entreprise_id correspond déjà à p_entreprise_id — sinon le RLS de
-- compteur_reference_declaration bloque l'écriture interne à la fonction.
--
-- INSERT ... ON CONFLICT DO UPDATE SET valeur = valeur + 1 est l'idiome
-- Postgres standard pour un compteur atomique : le conflit sur la clé
-- (entreprise_id, annee) prend un verrou de ligne, sérialisant les appels
-- concurrents sur la MÊME entreprise/année sans jamais lire une valeur
-- périmée (contrairement à un SELECT max(...) + 1 séparé).
CREATE OR REPLACE FUNCTION generer_reference_declaration(p_entreprise_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_annee  integer := extract(year FROM now())::int;
  v_valeur integer;
BEGIN
  INSERT INTO compteur_reference_declaration (entreprise_id, annee, valeur)
  VALUES (p_entreprise_id, v_annee, 1)
  ON CONFLICT (entreprise_id, annee)
    DO UPDATE SET valeur = compteur_reference_declaration.valeur + 1
  RETURNING valeur INTO v_valeur;

  RETURN 'INC-' || v_annee || '-' || lpad(v_valeur::text, 4, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION generer_reference_declaration(uuid) TO ifecarm_app;

-- =====================================================================
-- 1. DÉCLARATIONS
--
-- Une déclaration est faite depuis le terrain, souvent hors ligne, par
-- quelqu'un qui n'a pas forcément de compte. Elle doit se saisir en
-- moins d'une minute, sinon personne ne déclare.
-- =====================================================================

CREATE TABLE declaration (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  site_id         uuid        REFERENCES site(id) ON DELETE SET NULL,
  reference       text        NOT NULL,   -- ex. INC-2026-0147, généré à l'insertion (cf. en-tête)

  type            text        NOT NULL
                  CHECK (type IN ('accident_avec_arret','accident_sans_arret',
                                  'presqu_accident','situation_dangereuse',
                                  'incident_materiel','incident_environnemental')),

  -- Saisie du déclarant
  survenu_le      timestamptz NOT NULL,
  lieu            text,
  service         text,
  description     text        NOT NULL,
  -- Déclaration anonyme : declarant_id et salarie_id restent NULL.
  -- Sans anonymat possible, les presqu'accidents ne remontent pas.
  anonyme         boolean     NOT NULL DEFAULT false,
  declarant_id    uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,

  -- Victime éventuelle. Un accident sans victime identifiée reste
  -- déclarable : on ne bloque pas la saisie terrain.
  salarie_id      uuid        REFERENCES salarie(id) ON DELETE SET NULL,
  victime_externe text,       -- intérimaire, sous-traitant, visiteur
  arret_travail   boolean,
  jours_arret     integer     CHECK (jours_arret IS NULL OR jours_arret >= 0),

  -- Qualification par le responsable QHSE
  statut          text        NOT NULL DEFAULT 'a_qualifier'
                  CHECK (statut IN ('a_qualifier','en_analyse','en_action',
                                    'cloturee','sans_suite')),
  gravite         integer     CHECK (gravite BETWEEN 1 AND 4),
  frequence       integer     CHECK (frequence BETWEEN 1 AND 4),
  criticite       integer GENERATED ALWAYS AS (gravite * frequence) STORED,
  qualifie_par    uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  qualifie_le     timestamptz,
  motif_sans_suite text,

  -- Traçabilité de la saisie hors ligne
  -- Identifiant généré par l'appareil : garantit qu'une synchronisation
  -- rejouée ne crée pas de doublon.
  cle_client      text,
  saisi_hors_ligne boolean    NOT NULL DEFAULT false,
  synchronise_le  timestamptz,

  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (entreprise_id, reference),
  UNIQUE (entreprise_id, cle_client),
  -- Une déclaration anonyme ne porte ni déclarant ni victime nommée.
  CHECK (NOT anonyme OR (declarant_id IS NULL AND salarie_id IS NULL))
);

CREATE INDEX idx_declaration_entreprise_date
  ON declaration(entreprise_id, survenu_le DESC);
CREATE INDEX idx_declaration_a_traiter
  ON declaration(entreprise_id, statut)
  WHERE statut IN ('a_qualifier','en_analyse','en_action');
CREATE INDEX idx_declaration_site ON declaration(site_id);

-- Photos et documents joints. Le fichier lui-même vit dans le stockage
-- objet ; la table fichier du socle porte la référence.
CREATE TABLE piece_jointe_declaration (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  declaration_id  uuid        NOT NULL REFERENCES declaration(id) ON DELETE CASCADE,
  fichier_id      uuid        NOT NULL REFERENCES fichier(id) ON DELETE CASCADE,
  legende         text,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2. ANALYSE DES CAUSES
--
-- La méthode reste au choix du client : 5 pourquoi, arbre des causes,
-- ou saisie libre. On stocke le résultat, pas une structure imposée.
--
-- Format de `etapes` (documenté, cf. plan) :
--   methode = 'cinq_pourquoi'    : { ordre: number, question: string, reponse: string }[]
--   methode = 'arbre_des_causes' : { id: string, texte: string, parentIds: string[] }[]
--   methode = 'libre'            : { texte: string }[]
-- =====================================================================

CREATE TABLE analyse_cause (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  declaration_id  uuid        NOT NULL REFERENCES declaration(id) ON DELETE CASCADE,
  methode         text        NOT NULL DEFAULT 'libre'
                  CHECK (methode IN ('cinq_pourquoi','arbre_des_causes','libre')),
  etapes          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  causes_profondes text[],
  realisee_par    uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  realisee_le     date,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (declaration_id)
);

-- =====================================================================
-- 3. PLAN D'ACTION
--
-- Table partagée avec les autres modules : une action peut naître d'une
-- déclaration (B3), d'une inspection (B5) ou d'un audit. origine_type et
-- origine_id portent la source, sans contrainte de clé étrangère puisque
-- les modules n'existent pas tous au même moment.
-- =====================================================================

CREATE TABLE action_corrective (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  site_id         uuid        REFERENCES site(id) ON DELETE SET NULL,
  reference       text        NOT NULL,

  origine_type    text        NOT NULL
                  CHECK (origine_type IN ('declaration','inspection','audit',
                                          'revue_direction','autre')),
  origine_id      uuid,

  libelle         text        NOT NULL,
  description     text,
  -- Hiérarchie des mesures de prévention, dans cet ordre — l'ordre
  -- d'affichage à l'écran doit le respecter (message en soi, cf. tâche) :
  -- suppression > substitution > protection_collective >
  -- protection_individuelle > organisation > formation > consigne.
  nature          text        CHECK (nature IN ('suppression','substitution',
                                                'protection_collective',
                                                'protection_individuelle',
                                                'organisation','formation',
                                                'consigne')),

  responsable_id  uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  responsable_nom text,       -- si la personne n'a pas de compte
  echeance        date,

  statut          text        NOT NULL DEFAULT 'a_faire'
                  CHECK (statut IN ('a_faire','en_cours','realisee',
                                    'verifiee','abandonnee')),
  realisee_le     date,
  preuve_id       uuid        REFERENCES fichier(id) ON DELETE SET NULL,
  -- Vérification d'efficacité : une action réalisée n'est pas une action
  -- efficace. C'est ce que contrôle un auditeur.
  verifiee_par    uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  verifiee_le     date,
  efficace        boolean,
  commentaire_verification text,
  motif_abandon   text,

  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, reference)
);

CREATE INDEX idx_action_origine ON action_corrective(origine_type, origine_id);
CREATE INDEX idx_action_en_retard
  ON action_corrective(entreprise_id, echeance)
  WHERE statut IN ('a_faire','en_cours');
CREATE INDEX idx_action_responsable ON action_corrective(responsable_id);

-- Relances sur action en retard. Une ligne par action et par jalon :
-- la contrainte d'unicité empêche le doublon si le travailleur est relancé.
CREATE TABLE relance_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  action_id       uuid        NOT NULL REFERENCES action_corrective(id) ON DELETE CASCADE,
  jalon           text        NOT NULL
                  CHECK (jalon IN ('j_moins_7','echeance','j_plus_7','j_plus_30')),
  notification_id uuid        REFERENCES notification(id) ON DELETE SET NULL,
  declenchee_le   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, jalon)
);

-- =====================================================================
-- 4. SUIVI DES CHANGEMENTS
--
-- Le registre est une preuve documentaire présentée en audit : chaque
-- changement de statut d'une déclaration doit être traçable au-delà du
-- journal d'audit technique.
-- =====================================================================

CREATE TABLE historique_declaration (
  id              bigserial PRIMARY KEY,
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  declaration_id  uuid        NOT NULL REFERENCES declaration(id) ON DELETE CASCADE,
  utilisateur_id  uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  statut_avant    text,
  statut_apres    text        NOT NULL,
  commentaire     text,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_historique_declaration
  ON historique_declaration(declaration_id, cree_le);

-- =====================================================================
-- 5. HORODATAGE
-- =====================================================================

CREATE TRIGGER trg_declaration_modifie BEFORE UPDATE ON declaration
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();
CREATE TRIGGER trg_analyse_modifie BEFORE UPDATE ON analyse_cause
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();
CREATE TRIGGER trg_action_modifie BEFORE UPDATE ON action_corrective
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- =====================================================================
-- 6. RÔLES POSTGRES ET DROITS
-- =====================================================================

-- declaration/historique_declaration : jamais de DELETE (preuve
-- documentaire d'audit) ; declaration jamais figée par trigger comme
-- journal_audit (les statuts évoluent légitimement), mais le GRANT
-- n'autorise que ce qui doit l'être.
GRANT SELECT, INSERT, UPDATE         ON declaration              TO ifecarm_app;
GRANT SELECT, INSERT, DELETE         ON piece_jointe_declaration  TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON analyse_cause             TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON action_corrective         TO ifecarm_app;
GRANT SELECT, INSERT                 ON relance_action            TO ifecarm_app;
GRANT SELECT, INSERT                 ON historique_declaration    TO ifecarm_app;
GRANT USAGE, SELECT ON SEQUENCE historique_declaration_id_seq TO ifecarm_app;

-- =====================================================================
-- 7. CLOISONNEMENT
-- Aucune échappatoire platform_admin : un administrateur de la
-- plateforme n'a pas à lire les accidents des salariés d'un client.
-- L'accès d'un consultant passe par acces_consultant, nominatif et tracé.
-- =====================================================================

ALTER TABLE declaration              ENABLE ROW LEVEL SECURITY;
ALTER TABLE piece_jointe_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyse_cause            ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_corrective        ENABLE ROW LEVEL SECURITY;
ALTER TABLE relance_action           ENABLE ROW LEVEL SECURITY;
ALTER TABLE historique_declaration   ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloisonnement_declaration ON declaration FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_piece_jointe ON piece_jointe_declaration FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_analyse ON analyse_cause FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_action ON action_corrective FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_relance ON relance_action FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

CREATE POLICY cloisonnement_historique ON historique_declaration FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid);

-- =====================================================================
-- 8. INDICATEURS
--
-- Vue destinée au tableau de bord (B6). Elle ne fait aucun calcul
-- réglementaire : les taux de fréquence et de gravité sont calculés dans
-- B6, à partir des heures travaillées, qui ne sont pas dans ce module.
--
-- security_invoker = true (correction BLOQUANTE, cf. en-tête) : sans ça,
-- cette vue s'exécuterait avec les droits de son propriétaire
-- (ifecarm_migrate, exempté du RLS) et renverrait les déclarations de
-- toutes les entreprises à n'importe quel rôle qui l'interroge.
-- =====================================================================

CREATE VIEW v_declaration_mensuelle
WITH (security_invoker = true) AS
SELECT
  entreprise_id,
  site_id,
  date_trunc('month', survenu_le)::date AS mois,
  type,
  count(*)                                        AS nombre,
  count(*) FILTER (WHERE arret_travail)           AS avec_arret,
  coalesce(sum(jours_arret), 0)                   AS jours_arret_total
FROM declaration
WHERE statut <> 'sans_suite'
GROUP BY entreprise_id, site_id, date_trunc('month', survenu_le), type;

GRANT SELECT ON v_declaration_mensuelle TO ifecarm_app;
