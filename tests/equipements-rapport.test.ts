import { Client } from 'pg'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterConnexion } from '@/auth/routes'
import { traiterRapportEquipements } from '@/equipements/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/** Rapport PDF des équipements et EPI : réservé aux utilisateurs connectés, limité à leur entreprise (RLS), valide et paginé. */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
let f: Fixtures
const emails = new Map<string, string>()

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const req = (jeton?: string) => new Request(`${ORIGINE}/api/equipements/rapport`, {
  headers: { host: HOTE, ...(jeton ? { cookie: `ifecarm_session=${encodeURIComponent(jeton)}` } : {}) },
})
async function session(id: string): Promise<string> {
  const r = await traiterConnexion(new Request(`${ORIGINE}/api/auth/connexion`, {
    method: 'POST', headers: { host: HOTE, origin: ORIGINE, 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ email: emails.get(id), motDePasse: 'mot-de-passe-de-test-jamais-utilise' }),
  }))
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  return jeton
}
const pages = async (r: Response) => (await PDFDocument.load(new Uint8Array(await r.arrayBuffer()))).getPageCount()

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.utilisateurB1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inspections'), ($2, 'inspections')", [f.entrepriseA, f.entrepriseB])
    // A : 40 éléments (retard, bientôt, à jour, sans échéance, EPI, retiré) → plusieurs pages ; B : aucun.
    for (let i = 0; i < 40; i++) {
      const decalage = [-20, 10, 200, null][i % 4]
      await c.query(
        `INSERT INTO equipement (entreprise_id, type, designation, numero_serie, periodicite_mois, derniere_verif, prochaine_verif, actif)
         VALUES ($1, $2, $3, $4, 12, CURRENT_DATE - 100, ${decalage === null ? 'NULL' : `CURRENT_DATE + ${decalage}`}, $5)`,
        [f.entrepriseA, i % 5 === 0 ? 'EPI — harnais' : 'Extincteur', `Équipement de test ${i} avec une désignation assez longue pour passer à la ligne dans le rapport`, `SN-${i}`, i !== 39])
    }
  })
})

afterAll(async () => { try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ } })

describe('Rapport PDF des équipements et EPI', () => {
  it('sans session : refusé', async () => {
    expect((await traiterRapportEquipements(req())).status).toBe(401)
    expect((await traiterRapportEquipements(req('jeton-forge'))).status).toBe(401)
  })

  it('un client télécharge son rapport : PDF valide, plusieurs pages, jamais mis en cache', async () => {
    const r = await traiterRapportEquipements(req(await session(f.utilisateurA1)))
    expect(r.status, await r.clone().text()).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(r.headers.get('cache-control')).toMatch(/no-store/)
    expect(r.headers.get('content-disposition')).toMatch(/rapport-equipements-epi-.*\.pdf/)
    expect(await pages(r)).toBeGreaterThan(3)
  })

  it('cloisonnement : l’autre entreprise (sans équipement) obtient un rapport à elle, nettement plus court', async () => {
    const a = await pages(await traiterRapportEquipements(req(await session(f.utilisateurA1))))
    const b = await traiterRapportEquipements(req(await session(f.utilisateurB1)))
    expect(b.status).toBe(200)
    expect(await pages(b)).toBeLessThan(a)
  })
})
