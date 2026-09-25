import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { Fixtures } from './fixtures'

export interface FixturesFormations {
  formationCatalogue: string
  formationA: string
  formationB: string
  sessionA: string
  sessionB: string
  participantA: string
  participantB: string
  attestationA: string
  attestationB: string
  attestationACodeVerification: string
}

function codeVerification(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * S'appuie sur les entreprises/utilisateurs/salariés déjà créés par
 * creerFixtures() (cf. fixtures.ts) — toujours via ifecarm_migrate
 * (propriétaire, exempté du RLS), pour la même raison : préparer l'état,
 * pas démontrer le cloisonnement.
 */
export async function creerFixturesFormations(base: Fixtures): Promise<FixturesFormations> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()

  const suffixe = randomUUID().slice(0, 8)

  const { rows: [formationCatalogue] } = await client.query<{ id: string }>(
    `INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours, validite_mois)
     VALUES (NULL, $1, 'Sauveteur Secouriste du Travail', 'securite', 2, 24) RETURNING id`,
    [`sst-catalogue-${suffixe}`],
  )
  const { rows: [formationA] } = await client.query<{ id: string }>(
    `INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours, validite_mois)
     VALUES ($1, $2, 'Formation interne A', 'qualite', 1, NULL) RETURNING id`,
    [base.entrepriseA, `interne-a-${suffixe}`],
  )
  const { rows: [formationB] } = await client.query<{ id: string }>(
    `INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours, validite_mois)
     VALUES ($1, $2, 'Formation interne B', 'qualite', 1, NULL) RETURNING id`,
    [base.entrepriseB, `interne-b-${suffixe}`],
  )

  const { rows: [sessionA] } = await client.query<{ id: string }>(
    `INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 1) RETURNING id`,
    [base.entrepriseA, formationA!.id, `SESSION-A-${suffixe}`],
  )
  const { rows: [sessionB] } = await client.query<{ id: string }>(
    `INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 1) RETURNING id`,
    [base.entrepriseB, formationB!.id, `SESSION-B-${suffixe}`],
  )

  const { rows: [participantA] } = await client.query<{ id: string }>(
    `INSERT INTO participant (entreprise_id, session_id, salarie_id) VALUES ($1, $2, $3) RETURNING id`,
    [base.entrepriseA, sessionA!.id, base.salarieA1],
  )
  const { rows: [participantB] } = await client.query<{ id: string }>(
    `INSERT INTO participant (entreprise_id, session_id, salarie_id) VALUES ($1, $2, $3) RETURNING id`,
    [base.entrepriseB, sessionB!.id, base.salarieB1],
  )

  await client.query(
    `INSERT INTO emargement (entreprise_id, participant_id, jour, demi_journee, present)
     VALUES ($1, $2, CURRENT_DATE, 'matin', true)`,
    [base.entrepriseA, participantA!.id],
  )
  await client.query(
    `INSERT INTO emargement (entreprise_id, participant_id, jour, demi_journee, present)
     VALUES ($1, $2, CURRENT_DATE, 'matin', true)`,
    [base.entrepriseB, participantB!.id],
  )

  const attestationACodeVerification = codeVerification()

  const { rows: [attestationA] } = await client.query<{ id: string }>(
    `INSERT INTO attestation
       (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie,
        intitule_formation, nom_entreprise, date_debut, date_fin)
     VALUES ($1, $2, $3, 'Salarié', 'A1', 'Formation interne A (figée)', 'Test Cloisonnement A', CURRENT_DATE, CURRENT_DATE + 1)
     RETURNING id`,
    [base.entrepriseA, participantA!.id, attestationACodeVerification],
  )
  const { rows: [attestationB] } = await client.query<{ id: string }>(
    `INSERT INTO attestation
       (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie,
        intitule_formation, nom_entreprise, date_debut, date_fin)
     VALUES ($1, $2, $3, 'Salarié', 'B1', 'Formation interne B (figée)', 'Test Cloisonnement B', CURRENT_DATE, CURRENT_DATE + 1)
     RETURNING id`,
    [base.entrepriseB, participantB!.id, codeVerification()],
  )

  await client.query(
    `INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 30)`,
    [base.entrepriseA, attestationA!.id],
  )
  await client.query(
    `INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 30)`,
    [base.entrepriseB, attestationB!.id],
  )

  await client.end()

  return {
    formationCatalogue: formationCatalogue!.id,
    formationA: formationA!.id,
    formationB: formationB!.id,
    sessionA: sessionA!.id,
    sessionB: sessionB!.id,
    participantA: participantA!.id,
    participantB: participantB!.id,
    attestationA: attestationA!.id,
    attestationB: attestationB!.id,
    attestationACodeVerification,
  }
}

/**
 * À appeler APRÈS nettoyerFixtures(base) (socle) — pas avant. formationA et
 * formationB sont déjà supprimées à ce stade par la cascade depuis
 * entreprise (formation.entreprise_id -> ON DELETE CASCADE), Postgres
 * résolvant correctement le graphe de cascade malgré le ON DELETE RESTRICT
 * de session_formation.formation_id (les deux tables sont supprimées dans
 * la même opération de cascade depuis la même entreprise racine).
 * formationCatalogue (entreprise_id NULL) n'est concernée par aucune
 * cascade et doit être supprimée ici explicitement.
 */
export async function nettoyerFixturesFormations(f: FixturesFormations): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  await client.query('DELETE FROM formation WHERE id = $1', [f.formationCatalogue])
  await client.query('DELETE FROM verification_attestation WHERE code_verification = $1', [
    f.attestationACodeVerification,
  ])
  await client.end()
}
