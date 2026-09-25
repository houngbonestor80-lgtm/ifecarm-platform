-- =====================================================================
-- Plateforme QHSE IFECARM — socle commun
-- PostgreSQL 15+
--
-- Basé sur socle-schema.sql fourni, avec les corrections issues de la revue
-- de sécurité (voir commentaires "REVUE :" à chaque endroit modifié) :
--   1. ENABLE ROW LEVEL SECURITY sur toutes les tables cloisonnées, et un
--      second rôle non-propriétaire (ifecarm_app) qui exécute réellement les
--      requêtes applicatives — ifecarm_migrate (propriétaire) reste
--      délibérément exempté du RLS (ENABLE seul, jamais FORCE : cf. section
--      11 pour le détail de ce choix).
--   2. Chaque politique a un WITH CHECK, pas seulement un USING : sans lui,
--      rien n'empêche d'insérer une ligne portant l'entreprise_id d'un autre
--      client.
--   3. role_utilisateur et acces_consultant, qui n'ont pas (ou pas
--      directement exploitable) de colonne entreprise_id, sont cloisonnés
--      via jointure ou via une variable de session dédiée — détaillé à leurs
--      sections respectives.
--   4. GRANT explicites par table pour ifecarm_app : le socle décrit
--      entièrement les droits de son propre rôle applicatif.
--
-- Convention des variables de session (posées uniquement par le code
-- serveur, jamais dérivées d'une entrée utilisateur) :
--   app.entreprise_id  — uuid, entreprise cliente courante (withTenant)
--   app.utilisateur_id — uuid, utilisateur authentifié (withAuthenticatedUser
--                         et withTenant) ; posé dès la connexion, avant même
--                         le choix d'entreprise pour un consultant.
--   app.platform_admin — 'true'/'false', posé uniquement par
--                         withPlatformAdmin() pour les opérations
--                         admin_plateforme explicitement autorisées.
--
-- NULLIF(current_setting(...), '')::uuid plutôt que current_setting(...)::uuid
-- directement, partout dans les politiques ci-dessous : avec un pool de
-- connexions, une variable de session personnalisée jamais définie DANS LA
-- TRANSACTION COURANTE mais déjà positionnée par une transaction PRÉCÉDENTE
-- sur la MÊME connexion physique réutilisée par le pool revient comme une
-- chaîne VIDE (pas NULL) une fois SET LOCAL sorti de portée — ''::uuid lève
-- une erreur là où NULL::uuid ne lève rien (comparaison simplement fausse).
-- Sans NULLIF, ce comportement fait planter toute requête sous
-- withAuthenticatedUser/withPlatformAdmin/withoutTenant dès que la connexion
-- physique a déjà servi une transaction withTenant.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- =====================================================================
-- 1. ENTREPRISES ET ABONNEMENTS
-- =====================================================================

CREATE TABLE entreprise (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom             text        NOT NULL,
  pays            text        NOT NULL,              -- BJ, CI, TG, FR...
  secteur         text,
  effectif        integer,
  adresse         text,
  telephone       text,
  email_contact   text,
  -- Un client interne (IFECARM lui-même) n'est pas facturé.
  interne         boolean     NOT NULL DEFAULT false,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now()
);

-- Modules activés par entreprise. Un module désactivé disparaît de
-- l'interface et ses routes renvoient 403.
CREATE TABLE abonnement_module (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  module          text        NOT NULL
                  CHECK (module IN ('formations','incidents','habilitations',
                                    'inspections','tableau_bord')),
  actif           boolean     NOT NULL DEFAULT true,
  debut_le        date        NOT NULL DEFAULT CURRENT_DATE,
  fin_le          date,
  UNIQUE (entreprise_id, module)
);

-- =====================================================================
-- 2. SITES
-- =====================================================================

CREATE TABLE site (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  nom             text        NOT NULL,
  ville           text,
  pays            text,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_site_entreprise ON site(entreprise_id);

-- =====================================================================
-- 3. UTILISATEURS ET RÔLES
--
-- utilisateur = quelqu'un qui se connecte.
-- salarie     = quelqu'un dont on suit les formations et habilitations.
-- Les deux se recoupent mais ne se confondent pas : un manœuvre a des
-- habilitations sans jamais ouvrir l'application.
-- =====================================================================

CREATE TABLE utilisateur (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  email           citext      NOT NULL,
  nom             text        NOT NULL,
  telephone       text,
  -- Le mot de passe est géré par le fournisseur d'authentification ;
  -- on ne stocke ici que la référence externe.
  auth_ref        text        UNIQUE,
  actif           boolean     NOT NULL DEFAULT true,
  derniere_connexion timestamptz,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, email)
);

-- consultant_ifecarm : accès à plusieurs entreprises clientes, en lecture
-- ou en écriture selon le mandat. C'est le seul rôle transverse.
CREATE TABLE role_utilisateur (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  role            text        NOT NULL
                  CHECK (role IN ('admin_entreprise','responsable_qhse',
                                  'responsable_site','declarant',
                                  'consultant_ifecarm','admin_plateforme')),
  -- Limite le rôle à un site ; NULL = toute l'entreprise.
  site_id         uuid        REFERENCES site(id) ON DELETE CASCADE,
  UNIQUE (utilisateur_id, role, site_id)
);

-- Accès d'un consultant IFECARM à une entreprise cliente, avec date de fin :
-- un mandat terminé ferme l'accès sans intervention manuelle.
CREATE TABLE acces_consultant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  ecriture        boolean     NOT NULL DEFAULT false,
  fin_le          date,
  UNIQUE (utilisateur_id, entreprise_id)
);

-- =====================================================================
-- 4. SALARIÉS
-- Données personnelles : voir la section RGPD du cahier des charges.
-- =====================================================================

CREATE TABLE salarie (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  site_id         uuid        REFERENCES site(id) ON DELETE SET NULL,
  matricule       text,
  nom             text        NOT NULL,
  prenom          text        NOT NULL,
  date_naissance  date,
  poste           text,
  service         text,
  email           citext,
  telephone       text,
  date_embauche   date,
  date_sortie     date,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, matricule)
);

CREATE INDEX idx_salarie_entreprise ON salarie(entreprise_id);
CREATE INDEX idx_salarie_site ON salarie(site_id);

-- =====================================================================
-- 5. ÉQUIPEMENTS
-- Utilisé par les modules habilitations/EPI et inspections.
-- =====================================================================

CREATE TABLE equipement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  site_id         uuid        REFERENCES site(id) ON DELETE SET NULL,
  type            text        NOT NULL,   -- extincteur, appareil de levage, EPI...
  designation     text        NOT NULL,
  numero_serie    text,
  date_mise_service date,
  periodicite_mois integer,               -- périodicité de vérification
  prochaine_verif date,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_equipement_entreprise ON equipement(entreprise_id);
CREATE INDEX idx_equipement_prochaine_verif ON equipement(prochaine_verif)
  WHERE actif;

-- =====================================================================
-- 6. FICHIERS
-- Les fichiers eux-mêmes vivent dans un stockage objet ; la base ne
-- conserve que la référence et les métadonnées.
-- =====================================================================

CREATE TABLE fichier (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  cle_stockage    text        NOT NULL UNIQUE,
  nom_origine     text        NOT NULL,
  type_mime       text,
  taille_octets   bigint,
  -- Table et ligne d'origine, sans contrainte : les modules ne sont pas
  -- tous créés au même moment.
  objet_type      text,
  objet_id        uuid,
  televerse_par   uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fichier_objet ON fichier(objet_type, objet_id);

-- =====================================================================
-- 7. NOTIFICATIONS
-- File d'attente commune : chaque module y dépose, un travailleur unique
-- envoie et réessaie en cas d'échec.
-- =====================================================================

CREATE TABLE notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  canal           text        NOT NULL CHECK (canal IN ('email','sms','interne')),
  destinataire    text        NOT NULL,
  sujet           text,
  corps           text        NOT NULL,
  module          text,
  statut          text        NOT NULL DEFAULT 'en_attente'
                  CHECK (statut IN ('en_attente','envoye','echec','annule')),
  tentatives      integer     NOT NULL DEFAULT 0,
  erreur          text,
  planifie_le     timestamptz NOT NULL DEFAULT now(),
  envoye_le       timestamptz,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_a_envoyer ON notification(planifie_le)
  WHERE statut = 'en_attente';

-- =====================================================================
-- 8. JOURNAL D'AUDIT
-- Exigé par les auditeurs : il doit être non modifiable.
-- Aucune mise à jour ni suppression n'est autorisée (trigger ci-dessous
-- ET absence de GRANT UPDATE/DELETE plus bas : deux couches indépendantes).
-- =====================================================================

CREATE TABLE journal_audit (
  id              bigserial PRIMARY KEY,
  entreprise_id   uuid        REFERENCES entreprise(id) ON DELETE SET NULL,
  utilisateur_id  uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  action          text        NOT NULL,   -- creation, modification, suppression, connexion, export
  objet_type      text        NOT NULL,
  objet_id        uuid,
  details         jsonb,
  adresse_ip      inet,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_journal_entreprise_date ON journal_audit(entreprise_id, cree_le DESC);
CREATE INDEX idx_journal_objet ON journal_audit(objet_type, objet_id);

CREATE OR REPLACE FUNCTION journal_immuable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''audit ne peut être ni modifié ni supprimé.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_immuable
  BEFORE UPDATE OR DELETE ON journal_audit
  FOR EACH ROW EXECUTE FUNCTION journal_immuable();

-- =====================================================================
-- 9. HORODATAGE AUTOMATIQUE
-- =====================================================================

CREATE OR REPLACE FUNCTION maj_modifie_le() RETURNS trigger AS $$
BEGIN
  NEW.modifie_le = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entreprise_modifie BEFORE UPDATE ON entreprise
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();
CREATE TRIGGER trg_salarie_modifie BEFORE UPDATE ON salarie
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- =====================================================================
-- 10. RÔLES POSTGRES ET DROITS
--
-- ifecarm_migrate (propriétaire, créé par docker/init-roles.sql) possède
-- déjà tout par défaut sur les objets qu'il vient de créer. Cette section
-- donne à ifecarm_app exactement les droits table par table dont
-- l'application a besoin — jamais plus. Le RLS filtre les LIGNES ; ces GRANT
-- filtrent les OPÉRATIONS (ex. journal_audit : aucun GRANT UPDATE/DELETE,
-- même si le RLS l'autorisait, l'opération reste refusée au niveau SQL).
-- =====================================================================

GRANT SELECT, INSERT, UPDATE                 ON entreprise         TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON abonnement_module  TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON site               TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON utilisateur        TO ifecarm_app;
GRANT SELECT, INSERT, DELETE                 ON role_utilisateur   TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE         ON acces_consultant   TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON salarie            TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON equipement         TO ifecarm_app;
GRANT SELECT, INSERT, DELETE                 ON fichier            TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE                 ON notification       TO ifecarm_app;
-- journal_audit : lecture + écriture SEULEMENT (immuabilité, cf. section 8).
GRANT SELECT, INSERT                         ON journal_audit      TO ifecarm_app;
GRANT USAGE, SELECT ON SEQUENCE journal_audit_id_seq TO ifecarm_app;

-- =====================================================================
-- 11. CLOISONNEMENT PAR ENTREPRISE (RLS)
--
-- Le filtrage applicatif ne suffit pas : un oubli de clause WHERE dans un
-- seul endroit exposerait les données d'un client à un autre. La base doit
-- refuser elle-même.
--
-- Volontairement ENABLE seul, PAS FORCE ROW LEVEL SECURITY : FORCE
-- appliquerait aussi les politiques au PROPRIÉTAIRE (ifecarm_migrate),
-- cassant précisément l'exemption du propriétaire sur laquelle repose toute
-- cette architecture à deux rôles (revue de sécurité, point 1 : « PostgreSQL
-- exempte le propriétaire de ses propres politiques » — c'est voulu, pas un
-- oubli). Avec FORCE, même le script de migration ne pourrait plus insérer
-- la ligne de départ ci-dessous sans avoir positionné de variables de
-- session au préalable. ifecarm_app, qui N'EST PAS propriétaire, reste
-- soumis aux politiques avec ENABLE seul — c'est la seule chose qui compte.
--
-- L'application positionne les variables de session ci-dessous à chaque
-- requête, à partir de la session authentifiée, et jamais depuis un
-- paramètre envoyé par le navigateur (cf. src/db/tenant.ts) :
--   - app.entreprise_id  : entreprise cliente courante
--   - app.utilisateur_id : utilisateur authentifié
--   - app.platform_admin : 'true' uniquement pour les opérations
--                           admin_plateforme explicitement listées
-- =====================================================================

ALTER TABLE entreprise         ENABLE ROW LEVEL SECURITY;
ALTER TABLE abonnement_module  ENABLE ROW LEVEL SECURITY;
ALTER TABLE site               ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilisateur        ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_utilisateur   ENABLE ROW LEVEL SECURITY;
ALTER TABLE acces_consultant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE salarie            ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipement         ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichier            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification       ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_audit      ENABLE ROW LEVEL SECURITY;

-- entreprise : l'id de la ligne EST la clé de tenant (pas de colonne
-- entreprise_id). Écriture réservée à admin_plateforme (création/édition
-- d'une entreprise cliente, cf. tâche section 5).
CREATE POLICY cloisonnement_entreprise ON entreprise
  USING (
    id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

-- abonnement_module : lecture par l'entreprise concernée (savoir quels
-- modules sont actifs), écriture réservée à admin_plateforme (activation
-- d'un module = décision commerciale, pas une action du client).
CREATE POLICY cloisonnement_abonnement_module ON abonnement_module
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_site ON site
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_utilisateur ON utilisateur
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

-- role_utilisateur : pas de colonne entreprise_id, cloisonné par jointure
-- vers utilisateur.entreprise_id. Le second OR (utilisateur_id = soi-même)
-- n'est présent qu'en lecture : c'est ce qui permet à un utilisateur tout
-- juste authentifié — avant même le choix d'une entreprise — de lire SES
-- PROPRES rôles pour déterminer où il peut se rendre. En écriture, on ne
-- s'auto-attribue jamais un rôle : seul un admin de l'entreprise (déjà dans
-- le contexte tenant) ou admin_plateforme peut en accorder un.
CREATE POLICY cloisonnement_role_utilisateur ON role_utilisateur
  USING (
    EXISTS (
      SELECT 1 FROM utilisateur u
      WHERE u.id = role_utilisateur.utilisateur_id
        AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    )
    OR utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM utilisateur u
      WHERE u.id = role_utilisateur.utilisateur_id
        AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    )
    OR current_setting('app.platform_admin', true) = 'true'
  );

-- acces_consultant : a bien une colonne entreprise_id (celle du CLIENT, pas
-- du consultant), mais la filtrer uniquement par app.entreprise_id casse le
-- cas d'usage réel — au moment où un consultant se connecte, on ne sait pas
-- encore dans quelle entreprise cliente il veut entrer : c'est justement
-- cette table qui répond à cette question. D'où le second OR sur
-- utilisateur_id, pour la résolution post-connexion. Écriture (accorder/
-- révoquer un accès) réservée à admin_plateforme.
CREATE POLICY cloisonnement_acces_consultant ON acces_consultant
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_salarie ON salarie
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_equipement ON equipement
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_fichier ON fichier
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY cloisonnement_notification ON notification
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

-- journal_audit : entreprise_id nullable dans le schéma d'origine (un
-- événement vraiment plateforme pourrait ne pas en avoir) ; l'écriture reste
-- rare et centralisée (cf. src/db/journal.ts), le WITH CHECK est une
-- barrière de second rang, pas le mécanisme principal.
CREATE POLICY cloisonnement_journal_audit ON journal_audit
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

-- =====================================================================
-- 12. DONNÉES DE DÉPART
-- =====================================================================

INSERT INTO entreprise (nom, pays, secteur, interne)
VALUES ('IFECARM GROUP', 'BJ', 'Conseil QHSE', true);
