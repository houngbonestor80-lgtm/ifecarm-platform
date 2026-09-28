-- =====================================================================
-- Plateforme QHSE IFECARM — module B5 : inspections
-- PostgreSQL 15+ (ON DELETE SET NULL (colonne) requiert PostgreSQL 15)
--
-- Conventions du socle : ENABLE sans FORCE, NULLIF partout, entreprise_id
-- NOT NULL sur les données du client, clés étrangères COMPOSITES
-- (…, entreprise_id) partout où une ligne en référence une autre — leçon des
-- migrations 0006/0007 : la RLS contrôle le entreprise_id écrit, jamais celui
-- de la ligne référencée.
--
-- Décisions actées (arbitrage du 28/09/2026) :
--
--   1. Un PROSPECT est une entreprise (entreprise.statut_relation =
--      'prospect'), pas une table séparée. Le socle sert tel quel (site,
--      equipement, fichier, notification, journal_audit, toutes les
--      politiques RLS) : aucune branche entreprise_id NULL, aucun CHECK
--      d'exclusivité. Convertir un prospect en client = changer son statut
--      et activer ses modules, sans migration de données.
--
--   2. Le consultant accède à un prospect par acces_consultant, comme pour un
--      client : accès borné dans le temps (fin_le), accordé par
--      admin_plateforme — SAUF pour la création terrain, via creer_prospect()
--      ci-dessous, exception étroite à l'arbitrage sur acces_consultant :
--      un seul effet (créer le prospect + l'accès du consultant APPELANT),
--      journalisé, borné.
--
--   3. Le plan d'action d'une non-conformité est une action_corrective (B3)
--      avec origine_type = 'inspection' et origine_id = non_conformite.id,
--      PAS une table plan_action séparée : B3 porte déjà responsable,
--      échéance, statuts, relances en retard, preuve et vérification
--      d'efficacité. Une seconde table aurait dédoublé cette mécanique et
--      scindé les indicateurs de B6. Correspondance avec la spec
--      ouvert → en cours → clos : a_faire → en_cours → realisee/verifiee
--      (abandonnee = clos sans réalisation). Un déclencheur garantit que
--      origine_id désigne bien une non-conformité de la même entreprise.
--
--   4. Données du client, pas données personnelles de salariés : platform_admin
--      voit toutes les inspections (contrairement à B2/B3).
-- =====================================================================

-- =====================================================================
-- 1. PROSPECT = ENTREPRISE À STATUT
-- =====================================================================

ALTER TABLE entreprise
  ADD COLUMN statut_relation text NOT NULL DEFAULT 'client'
  CHECK (statut_relation IN ('client', 'prospect'));

-- Un prospect ne peut avoir actifs que les modules qui le concernent. Fonction
-- SECURITY DEFINER : elle doit lire entreprise QUELLE QUE SOIT la visibilité
-- RLS de l'appelant, sinon elle passerait à côté d'un prospect hors tenant.
CREATE OR REPLACE FUNCTION verifier_modules_prospect() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'abonnement_module' THEN
    IF NEW.actif
       AND NEW.module NOT IN ('inspections', 'tableau_bord')
       AND EXISTS (SELECT 1 FROM entreprise e
                   WHERE e.id = NEW.entreprise_id AND e.statut_relation = 'prospect') THEN
      RAISE EXCEPTION
        'Le module % ne peut pas être activé pour un prospect : convertir d''abord l''entreprise en client.',
        NEW.module;
    END IF;
  ELSE  -- entreprise : passage à 'prospect' alors que d'autres modules sont actifs
    IF NEW.statut_relation = 'prospect' AND EXISTS (
         SELECT 1 FROM abonnement_module m
         WHERE m.entreprise_id = NEW.id AND m.actif
           AND m.module NOT IN ('inspections', 'tableau_bord')) THEN
      RAISE EXCEPTION 'Cette entreprise a des modules actifs réservés aux clients : impossible de la repasser en prospect.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION verifier_modules_prospect() FROM PUBLIC;

CREATE TRIGGER trg_module_prospect
  BEFORE INSERT OR UPDATE ON abonnement_module
  FOR EACH ROW EXECUTE FUNCTION verifier_modules_prospect();

CREATE TRIGGER trg_entreprise_statut_prospect
  BEFORE UPDATE OF statut_relation ON entreprise
  FOR EACH ROW EXECUTE FUNCTION verifier_modules_prospect();

-- =====================================================================
-- 2. creer_prospect() — création terrain par le consultant
--
-- Appelée sous withAuthenticatedUser(utilisateurId) : le appelant est lu dans
-- app.utilisateur_id (posé par le code serveur, jamais par le navigateur) et
-- son droit est REVÉRIFIÉ ici, à l'intérieur de la fonction. Effets, dans
-- cet ordre et pas d'autres : entreprise (statut prospect), abonnement des
-- deux seuls modules autorisés, accès du consultant appelant (écriture, avec
-- date de fin), entrée de journal.
--
-- Le journal est écrit avec entreprise_id NULL (comme withPlatformAdmin) et
-- l'identifiant du prospect dans objet_id, sans clé étrangère. Un prospect
-- abandonné n'est jamais supprimé : il est DÉSACTIVÉ (entreprise.desactive_le,
-- cf. 0010), car journal_audit est immuable par conception.
-- =====================================================================

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

  -- Plafond contre l'erreur de saisie en boucle ou l'abus : un consultant ne
  -- garde pas plus de 50 prospects à accès valide en même temps.
  SELECT count(*) INTO v_actifs
  FROM acces_consultant a
  JOIN entreprise e ON e.id = a.entreprise_id
  WHERE a.utilisateur_id = v_uid
    AND e.statut_relation = 'prospect'
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

REVOKE EXECUTE ON FUNCTION creer_prospect(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creer_prospect(text, text, text, integer) TO ifecarm_app;

-- =====================================================================
-- 3. CLÉS COMPOSITES CIBLES sur les tables du socle
-- =====================================================================

ALTER TABLE site       ADD CONSTRAINT site_id_entreprise_unique       UNIQUE (id, entreprise_id);
ALTER TABLE equipement ADD CONSTRAINT equipement_id_entreprise_unique UNIQUE (id, entreprise_id);
ALTER TABLE fichier    ADD CONSTRAINT fichier_id_entreprise_unique    UNIQUE (id, entreprise_id);

-- =====================================================================
-- 4. MODÈLES D'INSPECTION
--
-- entreprise_id NULL = modèle du catalogue IFECARM, lisible par tous,
-- modifiable uniquement par admin_plateforme (même règle que formation).
-- Un client peut aussi avoir ses propres modèles.
-- =====================================================================

CREATE TABLE modele_inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        REFERENCES entreprise(id) ON DELETE CASCADE,
  slug            text        NOT NULL,
  intitule        text        NOT NULL,
  -- Paramétrable : QHSE, conformité, ou tout autre domaine.
  domaine         text        NOT NULL,
  cible_type      text        NOT NULL CHECK (cible_type IN ('site', 'equipement')),
  description     text,
  actif           boolean     NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, slug)
);

CREATE INDEX idx_modele_inspection_domaine ON modele_inspection(domaine) WHERE actif;

CREATE TABLE item_modele_inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modele_id       uuid        NOT NULL REFERENCES modele_inspection(id) ON DELETE CASCADE,
  ordre           integer     NOT NULL CHECK (ordre > 0),
  libelle         text        NOT NULL,
  -- Consigne affichée au consultant sur le terrain : le modèle guide la saisie.
  aide            text,
  gravite_defaut  text        NOT NULL DEFAULT 'mineure'
                  CHECK (gravite_defaut IN ('mineure', 'majeure', 'critique')),
  UNIQUE (modele_id, ordre)
);

-- =====================================================================
-- 5. INSPECTIONS
-- =====================================================================

CREATE TABLE inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  modele_id       uuid        NOT NULL REFERENCES modele_inspection(id) ON DELETE RESTRICT,
  -- Figé au démarrage : le modèle peut évoluer sans réécrire l'historique.
  intitule_modele text        NOT NULL,
  cible_type      text        NOT NULL CHECK (cible_type IN ('site', 'equipement')),
  site_id         uuid,
  equipement_id   uuid,
  consultant_id   uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  date_inspection date        NOT NULL DEFAULT CURRENT_DATE,
  statut          text        NOT NULL DEFAULT 'brouillon'
                  CHECK (statut IN ('brouillon', 'en_cours', 'terminee', 'annulee')),
  commentaire     text,
  terminee_le     timestamptz,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  modifie_le      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, entreprise_id),
  -- Exactement une cible, cohérente avec cible_type.
  CHECK (
    (cible_type = 'site'       AND site_id IS NOT NULL AND equipement_id IS NULL) OR
    (cible_type = 'equipement' AND equipement_id IS NOT NULL AND site_id IS NULL)
  ),
  CHECK ((statut = 'terminee') = (terminee_le IS NOT NULL)),
  -- La cible doit appartenir à la même entreprise que l'inspection.
  FOREIGN KEY (site_id, entreprise_id)       REFERENCES site (id, entreprise_id)       ON DELETE RESTRICT,
  FOREIGN KEY (equipement_id, entreprise_id) REFERENCES equipement (id, entreprise_id) ON DELETE RESTRICT
);

CREATE INDEX idx_inspection_entreprise_date ON inspection(entreprise_id, date_inspection DESC);
CREATE INDEX idx_inspection_site ON inspection(site_id) WHERE site_id IS NOT NULL;
CREATE INDEX idx_inspection_equipement ON inspection(equipement_id) WHERE equipement_id IS NOT NULL;
CREATE INDEX idx_inspection_consultant ON inspection(consultant_id);

CREATE TABLE item_inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL,
  inspection_id   uuid        NOT NULL,
  -- Lien conservé vers l'item du modèle, mais le libellé est FIGÉ ici.
  item_modele_id  uuid        REFERENCES item_modele_inspection(id) ON DELETE SET NULL,
  ordre           integer     NOT NULL CHECK (ordre > 0),
  libelle         text        NOT NULL,
  -- NULL = pas encore renseigné.
  resultat        text        CHECK (resultat IN ('conforme', 'non_conforme', 'non_applicable')),
  commentaire     text,
  photo_id        uuid,
  UNIQUE (inspection_id, ordre),
  -- Cible d'une clé étrangère de non_conformite : l'item doit appartenir à la
  -- MÊME inspection que la non-conformité.
  UNIQUE (id, inspection_id),
  FOREIGN KEY (inspection_id, entreprise_id) REFERENCES inspection (id, entreprise_id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id, entreprise_id) REFERENCES fichier (id, entreprise_id) ON DELETE SET NULL (photo_id)
);

CREATE INDEX idx_item_inspection_inspection ON item_inspection(inspection_id);

CREATE TABLE non_conformite (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL,
  inspection_id   uuid        NOT NULL,
  item_inspection_id uuid,
  gravite         text        NOT NULL CHECK (gravite IN ('mineure', 'majeure', 'critique')),
  description     text        NOT NULL,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, entreprise_id),
  FOREIGN KEY (inspection_id, entreprise_id) REFERENCES inspection (id, entreprise_id) ON DELETE CASCADE,
  FOREIGN KEY (item_inspection_id, inspection_id) REFERENCES item_inspection (id, inspection_id)
    ON DELETE SET NULL (item_inspection_id)
);

CREATE INDEX idx_non_conformite_inspection ON non_conformite(inspection_id);
CREATE INDEX idx_non_conformite_gravite ON non_conformite(entreprise_id, gravite);

-- Le plan d'action = action_corrective (B3) avec origine_type 'inspection'.
-- origine_id est polymorphe (pas de clé étrangère possible) : ce déclencheur
-- garantit qu'il désigne une non-conformité de la MÊME entreprise. SECURITY
-- DEFINER pour ne pas dépendre de la visibilité RLS de l'appelant.
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
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION verifier_origine_action_inspection() FROM PUBLIC;

CREATE TRIGGER trg_action_origine_inspection
  BEFORE INSERT OR UPDATE OF origine_type, origine_id, entreprise_id ON action_corrective
  FOR EACH ROW EXECUTE FUNCTION verifier_origine_action_inspection();

CREATE TABLE rapport_inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id   uuid        NOT NULL,
  inspection_id   uuid        NOT NULL,
  fichier_id      uuid        NOT NULL,
  -- Régénérer un rapport crée une nouvelle version, l'ancienne est conservée.
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  genere_par      uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
  genere_le       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, version),
  FOREIGN KEY (inspection_id, entreprise_id) REFERENCES inspection (id, entreprise_id) ON DELETE CASCADE,
  FOREIGN KEY (fichier_id, entreprise_id) REFERENCES fichier (id, entreprise_id)
);

-- =====================================================================
-- 6. HORODATAGE
-- =====================================================================

CREATE TRIGGER trg_modele_inspection_modifie BEFORE UPDATE ON modele_inspection
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();
CREATE TRIGGER trg_inspection_modifie BEFORE UPDATE ON inspection
  FOR EACH ROW EXECUTE FUNCTION maj_modifie_le();

-- =====================================================================
-- 7. DROITS
-- =====================================================================

GRANT SELECT, INSERT, UPDATE         ON modele_inspection      TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON item_modele_inspection TO ifecarm_app;
-- Pas de DELETE sur les données d'inspection : une inspection s'annule
-- (statut), elle ne disparaît pas.
GRANT SELECT, INSERT, UPDATE         ON inspection             TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON item_inspection        TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE         ON non_conformite         TO ifecarm_app;
GRANT SELECT, INSERT                 ON rapport_inspection     TO ifecarm_app;

-- =====================================================================
-- 8. CLOISONNEMENT
-- =====================================================================

ALTER TABLE modele_inspection      ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_modele_inspection ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection             ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_inspection        ENABLE ROW LEVEL SECURITY;
ALTER TABLE non_conformite         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rapport_inspection     ENABLE ROW LEVEL SECURITY;

CREATE POLICY lecture_modele_inspection ON modele_inspection FOR SELECT
  USING (entreprise_id IS NULL
         OR entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');

CREATE POLICY ecriture_modele_inspection ON modele_inspection FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');

-- Les items héritent de la visibilité et des droits d'écriture de leur modèle.
CREATE POLICY lecture_item_modele ON item_modele_inspection FOR SELECT
  USING (EXISTS (SELECT 1 FROM modele_inspection m WHERE m.id = item_modele_inspection.modele_id));

CREATE POLICY ecriture_item_modele ON item_modele_inspection FOR ALL
  USING (EXISTS (SELECT 1 FROM modele_inspection m
                 WHERE m.id = item_modele_inspection.modele_id
                   AND (m.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
                        OR current_setting('app.platform_admin', true) = 'true')))
  WITH CHECK (EXISTS (SELECT 1 FROM modele_inspection m
                      WHERE m.id = item_modele_inspection.modele_id
                        AND (m.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
                             OR current_setting('app.platform_admin', true) = 'true')));

CREATE POLICY cloisonnement_inspection ON inspection FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');

CREATE POLICY cloisonnement_item_inspection ON item_inspection FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');

CREATE POLICY cloisonnement_non_conformite ON non_conformite FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');

CREATE POLICY cloisonnement_rapport_inspection ON rapport_inspection FOR ALL
  USING (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
         OR current_setting('app.platform_admin', true) = 'true');
