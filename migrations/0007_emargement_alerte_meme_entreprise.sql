-- =====================================================================
-- emargement et alerte_recyclage : même entreprise que leur parent.
--
-- Même faille que celle fermée par 0006 pour attestation : ces deux tables
-- portent un entreprise_id à côté d'une clé étrangère (participant_id /
-- attestation_id) sans que rien ne garantisse que la ligne référencée
-- appartient à la même entreprise. La RLS contrôle le entreprise_id ÉCRIT,
-- pas celui de la ligne référencée (les clés étrangères de Postgres ne
-- passent pas par les politiques).
--
-- Même correctif : clé étrangère composite, qui REMPLACE la clé étrangère
-- simple et conserve son comportement à la suppression (ON DELETE CASCADE,
-- inchangé par rapport à 0004).
-- =====================================================================

-- Garde-fou : échoue avec un message explicite si des lignes existantes
-- enfreignent déjà la règle. Exécuté par ifecarm_migrate (non soumis au RLS).
DO $$
DECLARE
  nb_emargement integer;
  nb_alerte integer;
BEGIN
  SELECT count(*) INTO nb_emargement
  FROM emargement e JOIN participant p ON p.id = e.participant_id
  WHERE p.entreprise_id <> e.entreprise_id;

  SELECT count(*) INTO nb_alerte
  FROM alerte_recyclage r JOIN attestation a ON a.id = r.attestation_id
  WHERE a.entreprise_id <> r.entreprise_id;

  IF nb_emargement > 0 OR nb_alerte > 0 THEN
    RAISE EXCEPTION
      'Incohérences avant 0007 : % émargement(s) et % alerte(s) de recyclage rattachés à une autre entreprise que leur parent.',
      nb_emargement, nb_alerte;
  END IF;
END
$$;

-- participant(id, entreprise_id) est déjà unique depuis 0006.
ALTER TABLE attestation
  ADD CONSTRAINT attestation_id_entreprise_unique UNIQUE (id, entreprise_id);

ALTER TABLE emargement
  DROP CONSTRAINT emargement_participant_id_fkey;
ALTER TABLE emargement
  ADD CONSTRAINT emargement_participant_meme_entreprise_fkey
  FOREIGN KEY (participant_id, entreprise_id)
  REFERENCES participant (id, entreprise_id)
  ON DELETE CASCADE;

ALTER TABLE alerte_recyclage
  DROP CONSTRAINT alerte_recyclage_attestation_id_fkey;
ALTER TABLE alerte_recyclage
  ADD CONSTRAINT alerte_recyclage_attestation_meme_entreprise_fkey
  FOREIGN KEY (attestation_id, entreprise_id)
  REFERENCES attestation (id, entreprise_id)
  ON DELETE CASCADE;
