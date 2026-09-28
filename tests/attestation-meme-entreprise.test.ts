import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Migration 0006 : attestation.entreprise_id doit être celui du participant
 * référencé. Ces tests vérifient que c'est la BASE qui refuse (clé étrangère
 * composite, SQLSTATE 23503), y compris pour une écriture que la politique RLS
 * laisse passer — c'est précisément le cas d'un bug applicatif : la RLS ne
 * contrôle que le entreprise_id écrit, jamais celui de la ligne référencée.
 */

const CONTRAINTE = 'attestation_participant_meme_entreprise_fkey'

let f: Fixtures
let ff: FixturesFormations

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
})

afterAll(async () => {
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré, cf. tests/tenant-isolation.test.ts
  }
  try {
    await nettoyerFixturesFormations(ff)
  } catch {
    // idem
  }
})

const valeursAttestation = (code: string) =>
  ({
    code_verification: code,
    nom_salarie: 'Salarié',
    prenom_salarie: 'Test',
    intitule_formation: 'Formation test 0006',
    nom_entreprise: 'Test 0006',
    date_debut: '2026-01-01',
    date_fin: '2026-01-02',
  }) as const

describe('attestation ↔ participant : même entreprise (migration 0006)', () => {
  it("l'application (ifecarm_app, RLS satisfaite) ne peut pas rattacher une attestation de A à un participant de B", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('attestation')
          .values({
            entreprise_id: f.entrepriseA, // la politique RLS accepte : c'est bien SON entreprise
            participant_id: ff.participantB, // mais le participant est celui de B
            ...valeursAttestation(`T0006-${randomUUID()}`),
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: CONTRAINTE })
  })

  it("même rejet pour le propriétaire des tables (ifecarm_migrate, non soumis au RLS) : c'est la contrainte, pas la politique", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    try {
      await expect(
        client.query(
          `INSERT INTO attestation
             (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie,
              intitule_formation, nom_entreprise, date_debut, date_fin)
           VALUES ($1, $2, $3, 'Salarié', 'Test', 'Formation test 0006', 'Test 0006', '2026-01-01', '2026-01-02')`,
          [f.entrepriseB, ff.participantA, `T0006-${randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: CONTRAINTE })
    } finally {
      await client.end()
    }
  })

  it("déplacer une attestation existante vers une autre entreprise sans son participant est rejeté (UPDATE)", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    try {
      // Depuis 0007, l'alerte de recyclage de cette attestation la référence aussi
      // par (attestation_id, entreprise_id) : selon l'ordre de vérification,
      // c'est l'une ou l'autre des deux clés composites qui refuse. Dans les
      // deux cas la base rejette le déplacement.
      await expect(
        client.query('UPDATE attestation SET entreprise_id = $1 WHERE id = $2', [f.entrepriseB, ff.attestationA]),
      ).rejects.toSatisfy(
        (e: { code?: string, constraint?: string }) =>
          e.code === '23503' &&
          [CONTRAINTE, 'alerte_recyclage_attestation_meme_entreprise_fkey'].includes(e.constraint ?? ''),
      )
    } finally {
      await client.end()
    }
  })

  it('cas nominal : une attestation de A sur un participant de A est acceptée', async () => {
    const code = `T0006-${randomUUID()}`
    const cree = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .insertInto('attestation')
        .values({
          entreprise_id: f.entrepriseA,
          participant_id: ff.participantA,
          ...valeursAttestation(code),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    )
    expect(cree.id).toBeTruthy()

    // ifecarm_app n'a pas DELETE sur attestation (jamais de suppression
    // applicative, cf. 0004) : nettoyage avec le rôle propriétaire.
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    await client.query('DELETE FROM attestation WHERE id = $1', [cree.id])
    await client.end()
  })
})
