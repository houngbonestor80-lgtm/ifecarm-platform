import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import {
  traiterAjoutPoint, traiterCreation, traiterDetail, traiterNonConformite, traiterResultat, traiterSuppression, traiterSuppressionPoint, traiterTerminer,
} from '@/inspections/routes'
import { withTenant } from '@/db/tenant'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * B5, migration 0048 — checklist LIBRE : l'inspecteur n'est pas limité aux modèles par défaut. Il écrit ses points au démarrage
 * (sans modèle, avec option « garder comme modèle de l'entreprise »), en ajoute en cours de route, reformule ou supprime les
 * siens ; les points issus d'un modèle restent figés ; plus rien ne bouge une fois l'inspection clôturée. Request → Response.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const MDP = 'mot-de-passe-de-test-jamais-utilise'

let f: Fixtures
let siteA: string
const emails = new Map<string, string>()
let consultant: string
let clientA: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const req = (methode: string, jeton: string, corps?: unknown) => new Request(`${ORIGINE}/api/x`, {
  method: methode,
  headers: { host: HOTE, origin: ORIGINE, cookie: `ifecarm_session=${encodeURIComponent(jeton)}`, ...(corps !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: corps === undefined ? undefined : JSON.stringify(corps),
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

const creer = (corps: Record<string, unknown>, jeton = consultant) => traiterCreation(req('POST', jeton, corps))
const libre = async (points: unknown[] = ['Extincteurs accessibles', 'Issues de secours dégagées'], extra: Record<string, unknown> = {}) => {
  const r = await creer({ intitule: 'Visite de sécurité libre', cibleType: 'site', siteId: siteA, points, ...extra })
  expect(r.status, await r.clone().text()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
interface Point { id: string, ordre: number, libelle: string, personnalise: boolean, resultat: string | null }
const detail = async (id: string, jeton = consultant) => (await (await traiterDetail(req('GET', jeton), id)).json() as { inspection: { intitule_modele: string, items: Point[], statut: string } }).inspection
const ajouter = (id: string, libelle: unknown, jeton = consultant) => traiterAjoutPoint(req('POST', jeton, { libelle }), id)
const patch = (id: string, itemId: string, corps: unknown, jeton = consultant) => traiterResultat(req('PATCH', jeton, corps), id, itemId)
const supprimerPt = (id: string, itemId: string, jeton = consultant) => traiterSuppressionPoint(req('DELETE', jeton), id, itemId)

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.consultantC1, f.utilisateurB1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inspections'), ($2, 'inspections')", [f.entrepriseA, f.entrepriseB])
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
    siteA = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site checklist libre') RETURNING id", [f.entrepriseA])).rows[0].id
  })
  consultant = await session(f.consultantC1, f.entrepriseA)
  clientA = await session(f.utilisateurA1)
})

afterAll(async () => { try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ } })

describe('Inspection en checklist libre', () => {
  it('sans modèle : intitulé, cible et points écrits par l’inspecteur ; points vides ignorés, ordre conservé', async () => {
    const id = await libre(['  Extincteurs accessibles ', '', { libelle: 'Issues de secours dégagées' }, '   '])
    const d = await detail(id)
    expect(d.intitule_modele).toBe('Visite de sécurité libre')
    expect(d.statut).toBe('en_cours')
    expect(d.items.map((i) => [i.ordre, i.libelle, i.personnalise])).toEqual([[1, 'Extincteurs accessibles', true], [2, 'Issues de secours dégagées', true]])
    const enBase = await migrate(async (c) => (await c.query('SELECT modele_id FROM inspection WHERE id = $1', [id])).rows[0])
    expect(enBase.modele_id).toBeNull()
  })

  it('un équipement peut aussi être inspecté en checklist libre ; nouveau site écrit à la volée', async () => {
    const eq = await migrate(async (c) => (await c.query("INSERT INTO equipement (entreprise_id, type, designation) VALUES ($1, 'Extincteur', 'Extincteur libre') RETURNING id", [f.entrepriseA])).rows[0].id)
    const r = await creer({ intitule: 'Contrôle libre', cibleType: 'equipement', equipementId: eq, points: ['Manomètre dans le vert'] })
    expect(r.status, await r.clone().text()).toBe(201)
    const r2 = await creer({ intitule: 'Visite d’un nouveau site', cibleType: 'site', nouveauSite: { nom: 'Entrepôt écrit à la main', ville: 'Cotonou' }, points: ['Clôture en bon état'] })
    expect(r2.status, await r2.clone().text()).toBe(201)
  })

  it('validation : intitulé, cible, au moins un point, 150 au plus, 500 caractères au plus', async () => {
    const mauvais: [string, Record<string, unknown>][] = [
      ['sans intitulé', { cibleType: 'site', siteId: siteA, points: ['a'] }],
      ['cible invalide', { intitule: 'x', cibleType: 'bateau', siteId: siteA, points: ['a'] }],
      ['sans point', { intitule: 'x', cibleType: 'site', siteId: siteA, points: [] }],
      ['points vides', { intitule: 'x', cibleType: 'site', siteId: siteA, points: ['', '  '] }],
      ['points absents', { intitule: 'x', cibleType: 'site', siteId: siteA }],
      ['151 points', { intitule: 'x', cibleType: 'site', siteId: siteA, points: Array.from({ length: 151 }, (_, i) => `Point ${i}`) }],
      ['point de 501 caractères', { intitule: 'x', cibleType: 'site', siteId: siteA, points: ['y'.repeat(501)] }],
    ]
    for (const [libelle, corps] of mauvais) expect((await creer(corps)).status, libelle).toBe(400)
  })

  it('« garder comme modèle » : la checklist devient un modèle de l’entreprise, réutilisable ; ses points sont alors ceux d’un modèle', async () => {
    const intitule = `Ma checklist ${randomUUID().slice(0, 6)}`
    const r = await creer({ intitule, cibleType: 'site', siteId: siteA, points: ['Point modèle 1', 'Point modèle 2'], enregistrerModele: true, domaine: 'Incendie' })
    expect(r.status, await r.clone().text()).toBe(201)
    const premier = ((await r.json()) as { id: string }).id
    const modele = await migrate(async (c) => (await c.query('SELECT m.id, m.entreprise_id, m.domaine, (SELECT count(*)::int FROM item_modele_inspection WHERE modele_id = m.id) AS n FROM modele_inspection m WHERE m.intitule = $1', [intitule])).rows)
    expect(modele).toHaveLength(1)
    expect(modele[0]).toMatchObject({ entreprise_id: f.entrepriseA, domaine: 'Incendie', n: 2 })
    expect((await detail(premier)).items.every((i) => !i.personnalise)).toBe(true)
    // Réutilisation : une autre inspection à partir de ce modèle.
    const r2 = await creer({ modeleId: modele[0].id, siteId: siteA })
    expect(r2.status, await r2.clone().text()).toBe(201)
    // Autre entreprise : le modèle n'existe pas pour elle.
    const chezB = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => sql`select 1 from modele_inspection where intitule = ${intitule}`.execute(trx))
    expect(chezB.rows).toHaveLength(0)
  })
})

describe('Points ajoutés en cours d’inspection', () => {
  it('ajouter un point à la fin ; le reformuler ; lui donner un verdict ; le supprimer', async () => {
    const id = await libre(['Point 1'])
    const r = await ajouter(id, '  Zone de stockage chimique étiquetée ')
    expect(r.status, await r.clone().text()).toBe(201)
    const itemId = ((await r.json()) as { id: string }).id
    let d = await detail(id)
    expect(d.items.map((i) => [i.ordre, i.libelle])).toEqual([[1, 'Point 1'], [2, 'Zone de stockage chimique étiquetée']])

    expect((await patch(id, itemId, { libelle: 'Zone chimique : étiquettes lisibles' })).status).toBe(200)
    expect((await patch(id, itemId, { resultat: 'conforme', commentaire: 'RAS' })).status).toBe(200)
    d = await detail(id)
    expect(d.items[1]).toMatchObject({ libelle: 'Zone chimique : étiquettes lisibles', resultat: 'conforme', personnalise: true })

    expect((await supprimerPt(id, itemId)).status).toBe(200)
    expect((await detail(id)).items).toHaveLength(1)
  })

  it('libellé vide ou trop long refusé', async () => {
    const id = await libre(['Point 1'])
    expect((await ajouter(id, '   ')).status).toBe(400)
    expect((await ajouter(id, 'z'.repeat(501))).status).toBe(400)
    expect((await ajouter(id, undefined)).status).toBe(400)
  })

  it('les points d’un modèle restent figés : ni reformulation ni suppression (« non applicable » existe), même en SQL direct', async () => {
    const intitule = `Modèle figé ${randomUUID().slice(0, 6)}`
    const m = await creer({ intitule, cibleType: 'site', siteId: siteA, points: ['Point du modèle'], enregistrerModele: true })
    const id = ((await m.json()) as { id: string }).id
    const modeleItem = (await detail(id)).items[0]!
    expect((await patch(id, modeleItem.id, { libelle: 'Réécrit' })).status).toBe(409)
    expect((await supprimerPt(id, modeleItem.id)).status).toBe(409)
    expect((await patch(id, modeleItem.id, { resultat: 'non_applicable' })).status).toBe(200)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => sql`delete from item_inspection where id = ${modeleItem.id}`.execute(trx))).rejects.toThrow(/issu d'un modèle/)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => sql`update item_inspection set libelle = 'Réécrit' where id = ${modeleItem.id}`.execute(trx))).rejects.toThrow(/figé/)
    // On peut en revanche AJOUTER des points à une inspection issue d'un modèle.
    expect((await ajouter(id, 'Point ajouté en plus du modèle')).status).toBe(201)
    expect((await detail(id)).items.map((i) => i.personnalise)).toEqual([false, true])
  })

  it('un point qui porte une non-conformité ne se supprime plus', async () => {
    const id = await libre(['Point à problème'])
    const itemId = (await detail(id)).items[0]!.id
    const nc = await traiterNonConformite(req('POST', consultant, { itemId, gravite: 'majeure', description: 'Défaut constaté' }), id)
    expect(nc.status, await nc.clone().text()).toBe(201)
    expect((await supprimerPt(id, itemId)).status).toBe(409)
  })

  it('200 points au maximum par inspection (base)', async () => {
    const id = await libre(['Point 1'])
    await migrate(async (c) => {
      for (let i = 2; i <= 200; i++) await c.query("INSERT INTO item_inspection (entreprise_id, inspection_id, ordre, libelle, personnalise) VALUES ($1, $2, $3, $4, true)", [f.entrepriseA, id, i, `Point ${i}`])
    })
    expect((await ajouter(id, 'Le 201e')).status).toBe(409)
  })
})

describe('Inspection clôturée et droits', () => {
  it('clôturée : on ne peut plus ajouter, reformuler ni supprimer de point (route et SQL direct)', async () => {
    const id = await libre(['Point 1'])
    const r = await ajouter(id, 'Point 2')
    const itemId = ((await r.json()) as { id: string }).id
    await patch(id, (await detail(id)).items[0]!.id, { resultat: 'conforme' })
    await patch(id, itemId, { resultat: 'conforme' })
    expect((await traiterTerminer(req('POST', consultant, {}), id)).status).toBe(200)
    expect((await ajouter(id, 'Trop tard')).status).toBe(409)
    expect((await patch(id, itemId, { libelle: 'Trop tard' })).status).toBe(409)
    expect((await supprimerPt(id, itemId)).status).toBe(409)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => sql`insert into item_inspection (entreprise_id, inspection_id, ordre, libelle, personnalise) values (${f.entrepriseA}, ${id}, 99, 'x', true)`.execute(trx))).rejects.toThrow(/clôturée/)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => sql`update item_inspection set libelle = 'x' where id = ${itemId}`.execute(trx))).rejects.toThrow(/clôturée/)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => sql`delete from item_inspection where id = ${itemId}`.execute(trx))).rejects.toThrow(/clôturée/)
  })

  it('supprimer une inspection supprime aussi ses points personnalisés (la cascade reste libre)', async () => {
    const id = await libre(['Point A', 'Point B'])
    await ajouter(id, 'Point C')
    expect((await traiterSuppression(req('DELETE', consultant), id)).status).toBe(200)
    const restants = await migrate(async (c) => (await c.query('SELECT count(*)::int AS n FROM item_inspection WHERE inspection_id = $1', [id])).rows[0].n)
    expect(restants).toBe(0)
  })

  it('le client (consultation seule) n’écrit rien : ni création libre, ni point, ni suppression', async () => {
    const id = await libre(['Point 1'])
    expect((await creer({ intitule: 'x', cibleType: 'site', siteId: siteA, points: ['a'] }, clientA)).status).toBe(403)
    expect((await ajouter(id, 'Intrus', clientA)).status).toBe(403)
    const itemId = (await detail(id)).items[0]!.id
    expect((await supprimerPt(id, itemId, clientA)).status).toBe(403)
    expect((await patch(id, itemId, { libelle: 'Intrus' }, clientA)).status).toBe(403)
    // Mais il lit les points ajoutés.
    expect((await detail(id, clientA)).items.map((i) => i.libelle)).toEqual(['Point 1'])
  })
})
