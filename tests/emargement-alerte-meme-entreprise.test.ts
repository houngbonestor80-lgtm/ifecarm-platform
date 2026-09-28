import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Migration 0007 : mêmes garanties que 0006 (attestation) pour emargement et
 * alerte_recyclage. Le rejet doit venir de la BASE (SQLSTATE 23503, clé
 * étrangère composite), y compris pour une écriture que la RLS laisse passer.
 */

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

describe('emargement ↔ participant : même entreprise (migration 0007)', () => {
  it("l'application ne peut pas émarger, sous l'entreprise A, un participant de B", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('emargement')
          .values({
            entreprise_id: f.entrepriseA, // RLS satisfaite
            participant_id: ff.participantB, // mais participant de B
            jour: '2026-02-01',
            demi_journee: 'matin',
            present: true,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'emargement_participant_meme_entreprise_fkey' })
  })

  it('cas nominal : émarger un participant de A sous A est accepté', async () => {
    await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .insertInto('emargement')
        .values({
          entreprise_id: f.entrepriseA,
          participant_id: ff.participantA,
          jour: '2026-02-02',
          demi_journee: 'apres_midi',
          present: true,
        })
        .execute(),
    )
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    await client.query("DELETE FROM emargement WHERE participant_id = $1 AND jour = '2026-02-02'", [ff.participantA])
    await client.end()
  })
})

describe('alerte_recyclage ↔ attestation : même entreprise (migration 0007)', () => {
  it("l'application ne peut pas déclencher, sous A, une alerte sur l'attestation de B", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('alerte_recyclage')
          .values({
            entreprise_id: f.entrepriseA, // RLS satisfaite
            attestation_id: ff.attestationB, // mais attestation de B
            jalon_jours: 90,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'alerte_recyclage_attestation_meme_entreprise_fkey' })
  })

  it("même rejet pour le propriétaire (sans RLS) : c'est la contrainte, pas la politique", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    try {
      await expect(
        client.query(
          'INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 90)',
          [f.entrepriseB, ff.attestationA],
        ),
      ).rejects.toMatchObject({ code: '23503' })
    } finally {
      await client.end()
    }
  })
})
