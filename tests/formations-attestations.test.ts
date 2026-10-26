import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { withTenant, withoutTenant } from '@/db/tenant'
import { annulerAttestation, emettreAttestations, genererAttestationPdf, listerAttestationsSession } from '@/formations/attestation'
import { enregistrerEmargement } from '@/formations/service'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/** Émission des attestations : conditions (réalisée, apte, présence complète), PDF, annulation. Via ifecarm_app. */

let f: Fixtures
let ff: FixturesFormations

const jour = (decalage: number) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10)
const consultantA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 })
const clientA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 })
const migrate = async (requetes: [string, unknown[]][]) => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { for (const [q, p] of requetes) await c.query(q, p) } finally { await c.end() }
}
const migrateLire = async (q: string, p: unknown[]) => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return (await c.query(q, p)).rows[0] } finally { await c.end() }
}
const emettre = () => withTenant(consultantA(), (trx) => emettreAttestations(trx, consultantA(), ff.sessionA))

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
  // État de départ maîtrisé : plus d'attestation de fixture, participant apte, une seule demi-journée émargée sur quatre.
  await migrate([
    ['DELETE FROM alerte_recyclage WHERE attestation_id = $1', [ff.attestationA]],
    ['DELETE FROM attestation WHERE id = $1', [ff.attestationA]],
    ["UPDATE participant SET resultat = 'apte' WHERE id = $1", [ff.participantA]],
  ])
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Attestations', () => {
  it('refuse l’émission tant que la session n’est pas réalisée', async () => {
    await expect(emettre()).rejects.toThrow(/Réalisée/)
  })

  it('n’émet pas pour une présence incomplète', async () => {
    await migrate([["UPDATE session_formation SET statut = 'realisee' WHERE id = $1", [ff.sessionA]]])
    const r = await emettre()
    expect(r.emises).toBe(0)
    expect(r.ignores[0]?.motif).toMatch(/présence incomplète \(1\/4/)
  })

  it('émet une seule fois pour un participant apte et présent partout, avec données figées et échéance', async () => {
    for (const j of [jour(0), jour(1)]) {
      for (const demiJournee of ['matin', 'apres_midi']) {
        await withTenant(consultantA(), (trx) => enregistrerEmargement(trx, consultantA(), ff.participantA, { jour: j, demiJournee, present: true }))
      }
    }
    const r = await emettre()
    expect(r.emises).toBe(1)
    expect((await emettre()).emises).toBe(0)
    const liste = await withTenant(clientA(), (trx) => listerAttestationsSession(trx, ff.sessionA))
    expect(liste).toHaveLength(1)
    expect(liste[0]!.statut).toBe('valide')
    expect(liste[0]!.expire_le).toBeNull() // formation A : sans validité
  })

  it('génère un PDF lisible par le client', async () => {
    const [a] = await withTenant(clientA(), (trx) => listerAttestationsSession(trx, ff.sessionA))
    const { octets } = await withTenant(clientA(), (trx) => genererAttestationPdf(trx, a!.id, 'http://localhost:3001'))
    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-')
  })

  it('annulation définitive : motif obligatoire, l’attestation disparaît (liste, vérification publique, PDF) et le client ne peut pas supprimer', async () => {
    const [a] = await withTenant(consultantA(), (trx) => listerAttestationsSession(trx, ff.sessionA))
    const { code } = await migrateLire('SELECT code_verification AS code FROM attestation WHERE id = $1', [a!.id])
    await expect(withTenant(consultantA(), (trx) => annulerAttestation(trx, consultantA(), a!.id, {}))).rejects.toThrow(/Motif/)
    await expect(withTenant(clientA(), (trx) => annulerAttestation(trx, clientA(), a!.id, { motif: 'x' }))).rejects.toThrow()
    expect(await withTenant(consultantA(), (trx) => listerAttestationsSession(trx, ff.sessionA))).toHaveLength(1)

    await withTenant(consultantA(), (trx) => annulerAttestation(trx, consultantA(), a!.id, { motif: 'Erreur de saisie' }))
    expect(await withTenant(consultantA(), (trx) => listerAttestationsSession(trx, ff.sessionA))).toHaveLength(0)
    await expect(withTenant(consultantA(), (trx) => genererAttestationPdf(trx, a!.id, 'http://localhost:3001'))).rejects.toThrow(/introuvable/)
    const verif = await withoutTenant((trx) => sql`select * from verifier_attestation(${code}, ${'127.0.0.1'})`.execute(trx))
    expect(verif.rows).toHaveLength(0)
    await expect(withTenant(consultantA(), (trx) => annulerAttestation(trx, consultantA(), a!.id, { motif: 'encore' }))).rejects.toThrow(/introuvable/)
    // Le participant redevient éligible.
    expect((await emettre()).emises).toBe(1)
  })
})
