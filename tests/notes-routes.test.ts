import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import { traiterAjoutNote, traiterListeNotes, traiterSuppressionNote } from '@/notes/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/** Routes des notes internes de bout en bout (vraie session) : équipe seulement, auteur, suppression, journal sans contenu. */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
let declarationA: string
let declarationB: string
let consultant2: string
const emails = new Map<string, string>()

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
function req(method: string, corps?: unknown, jeton?: string, url = `${ORIGINE}/api/x`): Request {
  const headers: Record<string, string> = { host: HOTE, 'content-type': 'application/json', 'x-forwarded-for': ip(), origin: ORIGINE }
  if (jeton) headers.cookie = `ifecarm_session=${encodeURIComponent(jeton)}`
  return new Request(url, { method, headers, body: corps === undefined ? undefined : JSON.stringify(corps) })
}
async function session(utilisateurId: string, entrepriseId?: string): Promise<string> {
  const r = await traiterConnexion(req('POST', { email: emails.get(utilisateurId), motDePasse: MOT_DE_PASSE }))
  expect(r.status).toBe(200)
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  if (entrepriseId) expect((await traiterChoixEntreprise(req('POST', { entrepriseId }, jeton))).status).toBe(200)
  return jeton
}
const corps = async (r: Response) => (await r.json()) as Record<string, any>
const liste = (jeton: string, type: string, id: string) => traiterListeNotes(req('GET', undefined, jeton, `${ORIGINE}/api/notes?type=${type}&id=${id}`))

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const hash = (await c.query('SELECT mot_de_passe_hash FROM utilisateur WHERE id = $1', [f.utilisateurA1])).rows[0].mot_de_passe_hash
    const email = `c2-${randomUUID().slice(0, 8)}@test.local`
    consultant2 = (await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.ifecarmInterne, email, 'Second consultant', hash])).rows[0].id
    await c.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'consultant_ifecarm')", [consultant2])
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true), ($3, $2, true)', [f.consultantC1, f.entrepriseA, consultant2])
    emails.set(consultant2, email)
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.consultantC1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    declarationA = (await c.query("INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description) VALUES ($1, $2, 'presqu_accident', now(), 'A') RETURNING id", [f.entrepriseA, `NR-A-${randomUUID().slice(0, 6)}`])).rows[0].id
    declarationB = (await c.query("INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description) VALUES ($1, $2, 'presqu_accident', now(), 'B') RETURNING id", [f.entrepriseB, `NR-B-${randomUUID().slice(0, 6)}`])).rows[0].id
  })
})

afterAll(async () => {
  try { await migrate((c) => c.query('DELETE FROM utilisateur WHERE id = $1', [consultant2])) } catch { /* idem */ }
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('Notes internes — routes', () => {
  it('l’équipe écrit et relit ; le client est refusé partout', async () => {
    const equipe = await session(f.consultantC1, f.entrepriseA)
    const client = await session(f.utilisateurA1)
    const r = await traiterAjoutNote(req('POST', { objetType: 'declaration', objetId: declarationA, contenu: 'Appeler le chef d’atelier jeudi' }, equipe))
    expect(r.status).toBe(201)
    const lues = (await corps(await liste(equipe, 'declaration', declarationA))).notes
    expect(lues).toHaveLength(1)
    expect(lues[0]).toMatchObject({ contenu: 'Appeler le chef d’atelier jeudi', supprimable: true })
    expect(lues[0].auteur_nom).not.toBe('-')
    expect((await liste(client, 'declaration', declarationA)).status).toBe(403)
    expect((await traiterAjoutNote(req('POST', { objetType: 'declaration', objetId: declarationA, contenu: 'x' }, client))).status).toBe(403)
    expect((await traiterSuppressionNote(req('DELETE', undefined, client), lues[0].id)).status).toBe(403)
  })

  it('validation : type inconnu, objet d’une autre entreprise, note vide', async () => {
    const equipe = await session(f.consultantC1, f.entrepriseA)
    expect((await traiterAjoutNote(req('POST', { objetType: 'entreprise', objetId: declarationA, contenu: 'x' }, equipe))).status).toBe(400)
    expect((await traiterAjoutNote(req('POST', { objetType: 'declaration', objetId: declarationB, contenu: 'x' }, equipe))).status).toBe(404)
    expect((await traiterAjoutNote(req('POST', { objetType: 'declaration', objetId: declarationA, contenu: '   ' }, equipe))).status).toBe(400)
    expect((await liste(equipe, 'inconnu', declarationA)).status).toBe(400)
  })

  it('un autre consultant relit la note mais ne peut pas la supprimer ; l’auteur le peut ; le journal ne garde jamais le contenu', async () => {
    const auteur = await session(f.consultantC1, f.entrepriseA)
    const autre = await session(consultant2, f.entrepriseA)
    const { id } = await corps(await traiterAjoutNote(req('POST', { objetType: 'declaration', objetId: declarationA, contenu: 'Contenu secret du journal' }, auteur)))
    const vue = (await corps(await liste(autre, 'declaration', declarationA))).notes.find((n: any) => n.id === id)
    expect(vue).toMatchObject({ contenu: 'Contenu secret du journal', supprimable: false })
    expect((await traiterSuppressionNote(req('DELETE', undefined, autre), id)).status).toBe(404)
    const journal = await migrate((c) => c.query("SELECT details::text AS d FROM journal_audit WHERE objet_type = 'note_objet' AND objet_id = $1", [id]))
    expect(journal.rows.map((r) => r.d).join(' ')).not.toContain('secret')
    expect((await traiterSuppressionNote(req('DELETE', undefined, auteur), id)).status).toBe(200)
  })
})
