import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { Fixtures } from './fixtures'

export interface FixturesRegistre {
  declarationA: string
  declarationB: string
  actionA: string
  actionB: string
}

/**
 * Une ligne par table du module, pour A et B — même logique que
 * fixtures-formations.ts : préparer l'état via ifecarm_migrate
 * (propriétaire, exempté du RLS), jamais démontrer quoi que ce soit ici.
 */
export async function creerFixturesRegistre(base: Fixtures): Promise<FixturesRegistre> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()

  const suffixe = randomUUID().slice(0, 8)

  const { rows: [declarationA] } = await client.query<{ id: string }>(
    `INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description)
     VALUES ($1, $2, 'presqu_accident', now(), 'Fixture A') RETURNING id`,
    [base.entrepriseA, `FIXTURE-A-${suffixe}`],
  )
  const { rows: [declarationB] } = await client.query<{ id: string }>(
    `INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description)
     VALUES ($1, $2, 'presqu_accident', now(), 'Fixture B') RETURNING id`,
    [base.entrepriseB, `FIXTURE-B-${suffixe}`],
  )

  const { rows: [fichierA] } = await client.query<{ id: string }>(
    `INSERT INTO fichier (entreprise_id, cle_stockage, nom_origine) VALUES ($1, $2, 'photo-a.jpg') RETURNING id`,
    [base.entrepriseA, `entreprise/${base.entrepriseA}/${suffixe}-a.jpg`],
  )
  const { rows: [fichierB] } = await client.query<{ id: string }>(
    `INSERT INTO fichier (entreprise_id, cle_stockage, nom_origine) VALUES ($1, $2, 'photo-b.jpg') RETURNING id`,
    [base.entrepriseB, `entreprise/${base.entrepriseB}/${suffixe}-b.jpg`],
  )

  await client.query(
    `INSERT INTO piece_jointe_declaration (entreprise_id, declaration_id, fichier_id) VALUES ($1, $2, $3)`,
    [base.entrepriseA, declarationA!.id, fichierA!.id],
  )
  await client.query(
    `INSERT INTO piece_jointe_declaration (entreprise_id, declaration_id, fichier_id) VALUES ($1, $2, $3)`,
    [base.entrepriseB, declarationB!.id, fichierB!.id],
  )

  await client.query(
    `INSERT INTO analyse_cause (entreprise_id, declaration_id, methode, etapes)
     VALUES ($1, $2, 'libre', '[{"texte":"Fixture A"}]'::jsonb)`,
    [base.entrepriseA, declarationA!.id],
  )
  await client.query(
    `INSERT INTO analyse_cause (entreprise_id, declaration_id, methode, etapes)
     VALUES ($1, $2, 'libre', '[{"texte":"Fixture B"}]'::jsonb)`,
    [base.entrepriseB, declarationB!.id],
  )

  const { rows: [actionA] } = await client.query<{ id: string }>(
    `INSERT INTO action_corrective (entreprise_id, reference, origine_type, origine_id, libelle)
     VALUES ($1, $2, 'declaration', $3, 'Action fixture A') RETURNING id`,
    [base.entrepriseA, `ACTION-A-${suffixe}`, declarationA!.id],
  )
  const { rows: [actionB] } = await client.query<{ id: string }>(
    `INSERT INTO action_corrective (entreprise_id, reference, origine_type, origine_id, libelle)
     VALUES ($1, $2, 'declaration', $3, 'Action fixture B') RETURNING id`,
    [base.entrepriseB, `ACTION-B-${suffixe}`, declarationB!.id],
  )

  await client.query(
    `INSERT INTO relance_action (entreprise_id, action_id, jalon) VALUES ($1, $2, 'j_moins_7')`,
    [base.entrepriseA, actionA!.id],
  )
  await client.query(
    `INSERT INTO relance_action (entreprise_id, action_id, jalon) VALUES ($1, $2, 'j_moins_7')`,
    [base.entrepriseB, actionB!.id],
  )

  await client.query(
    `INSERT INTO historique_declaration (entreprise_id, declaration_id, statut_apres)
     VALUES ($1, $2, 'a_qualifier')`,
    [base.entrepriseA, declarationA!.id],
  )
  await client.query(
    `INSERT INTO historique_declaration (entreprise_id, declaration_id, statut_apres)
     VALUES ($1, $2, 'a_qualifier')`,
    [base.entrepriseB, declarationB!.id],
  )

  await client.end()

  return {
    declarationA: declarationA!.id,
    declarationB: declarationB!.id,
    actionA: actionA!.id,
    actionB: actionB!.id,
  }
}

/** Nettoyée par cascade depuis entreprise (nettoyerFixtures du socle) — rien à faire ici. */
export async function nettoyerFixturesRegistre(): Promise<void> {
  // no-op, cf. commentaire ci-dessus.
}
