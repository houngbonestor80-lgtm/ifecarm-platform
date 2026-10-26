import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { enregistrerEmargement, obtenirSession } from '@/formations/service'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/** Émargement par demi-journée : service appelé via ifecarm_app (withTenant). La session de test dure aujourd'hui + 1 jour. */

let f: Fixtures
let ff: FixturesFormations

const jour = (decalage: number) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10)
const consultantA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 })
const clientA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 })
const emarger = (corps: Record<string, unknown>, id = ff.participantA) =>
  withTenant(consultantA(), (trx) => enregistrerEmargement(trx, consultantA(), id, corps))

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Émargement', () => {
  it('enregistre puis corrige une présence sans créer de doublon', async () => {
    await emarger({ jour: jour(1), demiJournee: 'apres_midi', present: true })
    await emarger({ jour: jour(1), demiJournee: 'apres_midi', present: false })
    const s = await withTenant(consultantA(), (trx) => obtenirSession(trx, ff.sessionA))
    const lignes = s.emargements.filter((e) => e.jour === jour(1) && e.demi_journee === 'apres_midi')
    expect(lignes).toHaveLength(1)
    expect(lignes[0]!.present).toBe(false)
  })

  it('refuse un jour hors période, une demi-journée ou une présence invalide', async () => {
    await expect(emarger({ jour: jour(5), demiJournee: 'matin', present: true })).rejects.toThrow(/hors de la période/)
    await expect(emarger({ jour: jour(0), demiJournee: 'soir', present: true })).rejects.toThrow(/Demi-journée/)
    await expect(emarger({ jour: jour(0), demiJournee: 'matin', present: 'oui' })).rejects.toThrow(/Présence/)
  })

  it('ne touche pas au participant d’une autre entreprise', async () => {
    await expect(emarger({ jour: jour(0), demiJournee: 'matin', present: true }, ff.participantB)).rejects.toThrow(/introuvable/)
  })

  it('refuse l’écriture à un client (RLS)', async () => {
    await expect(withTenant(clientA(), (trx) => enregistrerEmargement(trx, clientA(), ff.participantA, { jour: jour(0), demiJournee: 'matin', present: false })))
      .rejects.toThrow()
  })
})
