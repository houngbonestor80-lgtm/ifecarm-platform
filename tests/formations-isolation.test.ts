import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withPlatformAdmin, withTenant, withoutTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

let f: Fixtures
let ff: FixturesFormations

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
})

afterAll(async () => {
  // Ordre important : nettoyerFixturesFormations suppose que formationA/B
  // ont déjà disparu par cascade depuis entreprise (cf. commentaire dans
  // fixtures-formations.ts) — donc le socle d'abord.
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

describe('Cloisonnement par table — module formations', () => {
  it('session_formation : A ne voit que sa propre session', async () => {
    const sessions = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('session_formation').select('id').execute(),
    )
    const ids = sessions.map((s) => s.id)
    expect(ids).toContain(ff.sessionA)
    expect(ids).not.toContain(ff.sessionB)
  })

  it('participant : A ne voit que son propre participant', async () => {
    const participants = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('participant').select('id').execute(),
    )
    const ids = participants.map((p) => p.id)
    expect(ids).toContain(ff.participantA)
    expect(ids).not.toContain(ff.participantB)
  })

  it('emargement : A ne voit que son propre émargement', async () => {
    const emargements = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('emargement').select(['id', 'participant_id']).execute(),
    )
    expect(emargements.every((e) => e.participant_id === ff.participantA)).toBe(true)
  })

  it('attestation : A ne voit que sa propre attestation', async () => {
    const attestations = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('attestation').select('id').execute(),
    )
    const ids = attestations.map((a) => a.id)
    expect(ids).toContain(ff.attestationA)
    expect(ids).not.toContain(ff.attestationB)
  })

  it('alerte_recyclage : A ne voit que sa propre alerte', async () => {
    const alertes = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('alerte_recyclage').select(['id', 'attestation_id']).execute(),
    )
    expect(alertes.every((a) => a.attestation_id === ff.attestationA)).toBe(true)
  })

  it("écrire une session_formation en usurpant l'entreprise_id d'un AUTRE tenant est rejeté", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('session_formation')
          .values({
            entreprise_id: f.entrepriseB,
            formation_id: ff.formationA,
            reference: 'INTRUS',
            date_debut: '2026-01-01',
            date_fin: '2026-01-01',
          })
          .execute(),
      ),
    ).rejects.toThrow()
  })
})

describe('Catalogue de formations (entreprise_id NULL) — lecture partagée, écriture réservée', () => {
  it('A voit le catalogue IFECARM et sa propre formation, jamais celle de B', async () => {
    const formations = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('formation').select('id').execute(),
    )
    const ids = formations.map((r) => r.id)
    expect(ids).toContain(ff.formationCatalogue)
    expect(ids).toContain(ff.formationA)
    expect(ids).not.toContain(ff.formationB)
  })

  it("un utilisateur normal ne peut pas modifier une formation du catalogue partagé", async () => {
    const resultat = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .updateTable('formation')
        .set({ intitule: 'Modifié par A' })
        .where('id', '=', ff.formationCatalogue)
        .executeTakeFirst(),
    )
    expect(Number(resultat.numUpdatedRows)).toBe(0)
  })

  it('admin_plateforme peut modifier le catalogue partagé, et c’est journalisé', async () => {
    await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'gerer_catalogue_formation' },
      (trx) =>
        trx
          .updateTable('formation')
          .set({ intitule: 'Sauveteur Secouriste du Travail (MAJ)' })
          .where('id', '=', ff.formationCatalogue)
          .execute(),
    )

    const journal = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
      (trx) =>
        trx
          .selectFrom('journal_audit')
          .select('id')
          .where('action', '=', 'gerer_catalogue_formation')
          .execute(),
    )
    expect(journal.length).toBeGreaterThan(0)
  })
})

describe('alerte_recyclage — unicité par (attestation, jalon)', () => {
  it('une seconde alerte pour le même jalon est rejetée par la contrainte, pas par la logique applicative', async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('alerte_recyclage')
          .values({ entreprise_id: f.entrepriseA, attestation_id: ff.attestationA, jalon_jours: 30 })
          .execute(),
      ),
    ).rejects.toThrow()
  })
})

describe('Attestation — données figées à l’émission', () => {
  it('reste identique après modification de la formation et du salarié source', async () => {
    const avant = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .selectFrom('attestation')
        .select(['nom_salarie', 'prenom_salarie', 'intitule_formation'])
        .where('id', '=', ff.attestationA)
        .executeTakeFirstOrThrow(),
    )

    await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, async (trx) => {
      await trx.updateTable('formation').set({ intitule: 'Intitulé changé après coup' }).where('id', '=', ff.formationA).execute()
      await trx.updateTable('salarie').set({ nom: 'NomChangéAprèsCoup' }).where('id', '=', f.salarieA1).execute()
    })

    const apres = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .selectFrom('attestation')
        .select(['nom_salarie', 'prenom_salarie', 'intitule_formation'])
        .where('id', '=', ff.attestationA)
        .executeTakeFirstOrThrow(),
    )

    expect(apres).toEqual(avant)
    expect(apres.nom_salarie).not.toBe('NomChangéAprèsCoup')
    expect(apres.intitule_formation).not.toBe('Intitulé changé après coup')
  })
})

describe('verifier_attestation — fonction publique SECURITY DEFINER', () => {
  it('ifecarm_app n’a AUCUN accès direct à verification_attestation', async () => {
    await expect(
      withoutTenant((trx) => trx.selectFrom('verification_attestation').select('id').execute()),
    ).rejects.toThrow()
  })

  it('un code valide renvoie les champs affichables et journalise la consultation', async () => {
    const rows = await withoutTenant((trx) =>
      sql<{ nom_salarie: string, statut: string }>`
        select * from verifier_attestation(${ff.attestationACodeVerification}, ${'127.0.0.1'})
      `.execute(trx),
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.nom_salarie).toBe('Salarié')
    expect(rows.rows[0]?.statut).toBe('valide')

    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    const { rows: consultations } = await client.query(
      'SELECT trouvee FROM verification_attestation WHERE code_verification = $1',
      [ff.attestationACodeVerification],
    )
    await client.end()
    expect(consultations.length).toBeGreaterThan(0)
    expect(consultations.every((c) => c.trouvee === true)).toBe(true)
  })

  it('un code inconnu ne renvoie rien, mais journalise quand même la tentative', async () => {
    const codeInconnu = 'code-qui-n-existe-pas'
    const rows = await withoutTenant((trx) =>
      sql<{ nom_salarie: string }>`select * from verifier_attestation(${codeInconnu}, ${'127.0.0.1'})`.execute(trx),
    )
    expect(rows.rows).toHaveLength(0)

    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    const { rows: consultations } = await client.query(
      'SELECT trouvee FROM verification_attestation WHERE code_verification = $1',
      [codeInconnu],
    )
    expect(consultations).toHaveLength(1)
    expect(consultations[0].trouvee).toBe(false)

    await client.query('DELETE FROM verification_attestation WHERE code_verification = $1', [codeInconnu])
    await client.end()
  })
})
