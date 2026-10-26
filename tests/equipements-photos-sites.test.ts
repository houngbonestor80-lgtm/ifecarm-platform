import { Client } from 'pg'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import { traiterAjoutPhotoEquipement, traiterCreationEquipement, traiterListeEquipements, traiterRapportEquipements, traiterSuppressionEquipement } from '@/equipements/routes'
import { traiterLecturePhoto, traiterSuppressionPhoto } from '@/inspections/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Photos des équipements (stockage réel, objet_type 'equipement') et site saisi librement à la création d'un équipement.
 * Écriture : consultant avec mandat en écriture ; lecture : tout le tenant ; jamais une autre entreprise.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const MDP = 'mot-de-passe-de-test-jamais-utilise'
// PNG 1×1 valide (les octets sont contrôlés côté serveur ; pdf-lib doit aussi pouvoir l'intégrer au rapport).
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))

let f: Fixtures
const emails = new Map<string, string>()

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const req = (methode: string, jeton: string, corps?: unknown | FormData) => new Request(`${ORIGINE}/api/x`, {
  method: methode,
  headers: {
    host: HOTE, origin: ORIGINE, cookie: `ifecarm_session=${encodeURIComponent(jeton)}`,
    ...(corps !== undefined && !(corps instanceof FormData) ? { 'content-type': 'application/json' } : {}),
  },
  body: corps === undefined ? undefined : corps instanceof FormData ? corps : JSON.stringify(corps),
})
async function session(id: string, entrepriseId?: string): Promise<string> {
  const r = await traiterConnexion(new Request(`${ORIGINE}/api/auth/connexion`, {
    method: 'POST', headers: { host: HOTE, origin: ORIGINE, 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ email: emails.get(id), motDePasse: MDP }),
  }))
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  if (entrepriseId) expect((await traiterChoixEntreprise(req('POST', jeton, { entrepriseId }))).status).toBe(200)
  return jeton
}
const formPhoto = (octets: Uint8Array = PNG, nom = 'photo.png') => {
  const form = new FormData()
  form.append('photo', new File([octets as Uint8Array<ArrayBuffer>], nom, { type: 'image/png' }))
  return form
}
const liste = async (jeton: string) => (await (await traiterListeEquipements(req('GET', jeton))).json()) as { equipements: { id: string, designation: string, site_nom: string | null, photos: { id: string }[] }[], sites: { id: string, nom: string }[] }

let consultant: string
let clientA: string
let clientB: string
let equipementId: string

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.utilisateurB1, f.consultantC1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inspections'), ($2, 'inspections')", [f.entrepriseA, f.entrepriseB])
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
  })
  consultant = await session(f.consultantC1, f.entrepriseA)
  clientA = await session(f.utilisateurA1)
  clientB = await session(f.utilisateurB1)
})

afterAll(async () => { try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ } })

describe('Site saisi librement (équipement)', () => {
  it('« nouveau site » crée le site et le rattache ; le même nom (casse ignorée) réutilise le site existant', async () => {
    const creer = (designation: string, nom: string) => traiterCreationEquipement(req('POST', consultant, { type: 'EPI — casque', designation, nouveauSite: { nom, ville: 'Cotonou' } }))
    const a = await creer('Casque 1', 'Entrepôt Nord')
    expect(a.status, await a.clone().text()).toBe(201)
    equipementId = ((await a.json()) as { id: string }).id
    expect((await creer('Casque 2', '  entrepôt nord ')).status).toBe(201)
    const l = await liste(consultant)
    const sites = l.sites.filter((s) => s.nom.toLowerCase().trim() === 'entrepôt nord')
    expect(sites).toHaveLength(1)
    expect(l.equipements.filter((e) => e.designation.startsWith('Casque')).map((e) => e.site_nom)).toEqual(['Entrepôt Nord', 'Entrepôt Nord'])
  })

  it('un site de la liste reste possible ; un site d’une autre entreprise est refusé ; un client ne crée rien', async () => {
    const site = (await liste(consultant)).sites[0]!
    expect((await traiterCreationEquipement(req('POST', consultant, { type: 'Extincteur', designation: 'Extincteur liste', siteId: site.id }))).status).toBe(201)
    const siteB = await migrate(async (c) => (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site B') RETURNING id", [f.entrepriseB])).rows[0].id)
    expect((await traiterCreationEquipement(req('POST', consultant, { type: 'Extincteur', designation: 'Intrus', siteId: siteB }))).status).toBe(400)
    expect((await traiterCreationEquipement(req('POST', clientA, { type: 'Extincteur', designation: 'Client', nouveauSite: { nom: 'Pirate' } }))).status).toBe(403)
  })
})

describe('Photos d’équipement', () => {
  it('le consultant ajoute une photo ; elle apparaît dans le registre ; le client la voit ; le rapport reste un PDF valide', async () => {
    const r = await traiterAjoutPhotoEquipement(req('POST', consultant, formPhoto()), equipementId)
    expect(r.status, await r.clone().text()).toBe(201)
    const photoId = ((await r.json()) as { id: string }).id
    const eq = (await liste(clientA)).equipements.find((e) => e.id === equipementId)!
    expect(eq.photos.map((p) => p.id)).toEqual([photoId])
    const lecture = await traiterLecturePhoto(req('GET', clientA), photoId)
    expect(lecture.status).toBe(200)
    expect(lecture.headers.get('content-type')).toBe('image/png')
    const pdf = await traiterRapportEquipements(req('GET', clientA))
    expect(pdf.status).toBe(200)
    expect((await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()))).getPageCount()).toBeGreaterThan(1)
  })

  it('refus : client (consultation seule), fichier qui n’est pas une image, équipement d’une autre entreprise', async () => {
    expect((await traiterAjoutPhotoEquipement(req('POST', clientA, formPhoto()), equipementId)).status).toBe(403)
    expect((await traiterAjoutPhotoEquipement(req('POST', consultant, formPhoto(new TextEncoder().encode('<?php echo 1; ?>'), 'x.png')), equipementId)).status).toBe(400)
    const autre = await migrate(async (c) => (await c.query("INSERT INTO equipement (entreprise_id, type, designation) VALUES ($1, 'Extincteur', 'Chez B') RETURNING id", [f.entrepriseB])).rows[0].id)
    expect((await traiterAjoutPhotoEquipement(req('POST', consultant, formPhoto()), autre)).status).toBe(404)
  })

  it('cloisonnement : l’autre entreprise ne lit pas la photo ; seul le consultant la supprime', async () => {
    const photoId = (await liste(consultant)).equipements.find((e) => e.id === equipementId)!.photos[0]!.id
    expect((await traiterLecturePhoto(req('GET', clientB), photoId)).status).toBe(404)
    expect((await traiterSuppressionPhoto(req('DELETE', clientA), photoId)).status).toBe(403)
    expect((await traiterSuppressionPhoto(req('DELETE', consultant), photoId)).status).toBe(200)
    expect((await liste(consultant)).equipements.find((e) => e.id === equipementId)!.photos).toEqual([])
  })

  it('supprimer l’équipement supprime ses photos (fichiers compris)', async () => {
    await traiterAjoutPhotoEquipement(req('POST', consultant, formPhoto()), equipementId)
    expect((await traiterSuppressionEquipement(req('DELETE', consultant), equipementId)).status).toBe(200)
    const restants = await migrate(async (c) => (await c.query("SELECT count(*)::int AS n FROM fichier WHERE objet_type = 'equipement' AND objet_id = $1", [equipementId])).rows[0].n)
    expect(restants).toBe(0)
  })
})
