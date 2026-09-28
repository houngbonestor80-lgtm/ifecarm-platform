-- =====================================================================
-- attestation et participant doivent appartenir à la MÊME entreprise.
--
-- Trou identifié à l'audit du socle : rien en base ne reliait
-- attestation.entreprise_id à participant.entreprise_id. La politique RLS
-- vérifie qu'on écrit bien dans SON entreprise, mais les clés étrangères de
-- Postgres ne passent pas par les politiques : un bug applicatif qui
-- construirait lui-même une requête (participant_id d'une autre entreprise,
-- entreprise_id de l'appelant) l'aurait acceptée, et une attestation aurait
-- pu pointer vers le participant — donc le salarié, les notes et le résultat
-- d'aptitude — d'un autre client.
--
-- Correctif : clé étrangère COMPOSITE (participant_id, entreprise_id) vers
-- participant(id, entreprise_id). Postgres la vérifie nativement à chaque
-- insertion ET à chaque modification de l'une des deux colonnes. Elle
-- REMPLACE la clé étrangère simple sur participant_id (qu'elle implique) ;
-- même comportement à la suppression : ON DELETE RESTRICT, "l'attestation
-- reste en base" (cf. 0004).
--
-- Périmètre volontairement limité à attestation (demande explicite).
-- emargement et alerte_recyclage portent aussi un entreprise_id à côté d'une
-- clé étrangère (participant_id / attestation_id) sans contrainte de ce
-- type : même faille théorique, à traiter dans une migration à part si
-- besoin.
-- =====================================================================

-- Garde-fou : si des lignes existantes enfreignent déjà la règle, la
-- migration échoue avec un message explicite plutôt qu'avec une erreur de
-- contrainte opaque. Exécutée avec ifecarm_migrate (propriétaire, non soumis
-- au RLS) : voit toutes les lignes de toutes les entreprises.
DO $$
DECLARE
  nb integer;
BEGIN
  SELECT count(*) INTO nb
  FROM attestation a
  JOIN participant p ON p.id = a.participant_id
  WHERE p.entreprise_id <> a.entreprise_id;

  IF nb > 0 THEN
    RAISE EXCEPTION
      '% attestation(s) référencent un participant d''une autre entreprise : à corriger avant d''appliquer 0006.', nb;
  END IF;
END
$$;

-- Nécessaire pour qu'une autre table puisse référencer les deux colonnes
-- ensemble. id étant déjà unique, cette contrainte est toujours satisfaite
-- pour les données existantes.
ALTER TABLE participant
  ADD CONSTRAINT participant_id_entreprise_unique UNIQUE (id, entreprise_id);

ALTER TABLE attestation
  DROP CONSTRAINT attestation_participant_id_fkey;

ALTER TABLE attestation
  ADD CONSTRAINT attestation_participant_meme_entreprise_fkey
  FOREIGN KEY (participant_id, entreprise_id)
  REFERENCES participant (id, entreprise_id)
  ON DELETE RESTRICT;
