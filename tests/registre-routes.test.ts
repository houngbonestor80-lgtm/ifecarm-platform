import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import {
  traiterAjoutPiece, traiterAnalyse, traiterResumeRegistre, traiterCommentaire, traiterContexteRegistre, traiterCreationAction, traiterDeclaration, traiterDetail,
  traiterLecturePiece, traiterListe, traiterModification, traiterStatutAction, traiterSuppressionPiece,
} from '@/registre/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Routes B3 de bout en bout (vraie session → avecTenant → module « incidents » → RLS) : module requis,
 * un déclarant déclare et ne fait rien d'autre, anonymat, qualification et analyse par l'équipe,
 * actions, photos suivant la visibilité de la déclaration (0038).
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
// PNG 1×1 : octets valides pour la vérification du type réel.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

let f: Fixtures
let declarantId: string
let responsableId: string
const emails = new Map<string, string>()

async function avecMigrate<T>(cb: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  try { return await cb(client) } finally { await client.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
function req(method: string, corps?: unknown, jeton?: string): Request {
  const headers: Record<string, string> = { host: HOTE, 'content-type': 'application/json', 'x-forwarded-for': ip(), origin: ORIGINE }
  if (jeton) headers.cookie = `ifecarm_session=${encodeURIComponent(jeton)}`
  return new Request(`${ORIGINE}/api/x`, { method, headers, body: corps === undefined ? undefined : JSON.stringify(corps) })
}
function reqPhoto(jeton: string): Request {
  const form = new FormData()
  form.append('photo', new File([PNG], 'preuve.png', { type: 'image/png' }))
  return new Request(`${ORIGINE}/api/x`, { method: 'POST', headers: { host: HOTE, 'x-forwarded-for': ip(), origin: ORIGINE, cookie: `ifecarm_session=${encodeURIComponent(jeton)}` }, body: form })
}
async function session(utilisateurId: string, entrepriseId?: string): Promise<string> {
  const r = await traiterConnexion(req('POST', { email: emails.get(utilisateurId), motDePasse: MOT_DE_PASSE }))
  expect(r.status).toBe(200)
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie } }))!
  await libererA2f(jeton)
  if (entrepriseId) expect((await traiterChoixEntreprise(req('POST', { entrepriseId }, jeton))).status).toBe(200)
  return jeton
}
const corps = async (r: Response) => (await r.json()) as Record<string, any>
const faits = (extra: Record<string, unknown> = {}) => ({ type: 'presqu_accident', survenuLe: new Date().toISOString(), description: 'Chute de matériel sans blessé', lieu: 'Atelier', ...extra })

beforeAll(async () => {
  f = await creerFixtures()
  await avecMigrate(async (c) => {
    const hash = (await c.query('SELECT mot_de_passe_hash FROM utilisateur WHERE id = $1', [f.utilisateurA1])).rows[0].mot_de_passe_hash
    const creer = async (label: string, role: string) => {
      const email = `${label}-${randomUUID().slice(0, 8)}@test.local`
      const id = (await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.entrepriseA, email, label, hash])).rows[0].id
      await c.query('INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, $2)', [id, role])
      emails.set(id, email)
      return id as string
    }
    declarantId = await creer('declarant', 'declarant')
    responsableId = await creer('responsable', 'responsable_qhse')
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.utilisateurB1, f.consultantC1]])
    rows.forEach((r) => emails.set(r.id, r.email))
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('Module « incidents » requis', () => {
  it('sans module actif : 403, déclaration comprise', async () => {
    const declarant = await session(declarantId)
    expect((await traiterListe(req('GET', undefined, declarant))).status).toBe(403)
    expect((await traiterDeclaration(req('POST', faits(), declarant))).status).toBe(403)
  })
})

describe('Registre (entreprise A)', () => {
  let declarant: string
  let responsable: string
  let consultant: string
  let nominative: { id: string, reference: string }
  let anonyme: { id: string, reference: string }

  beforeAll(async () => {
    await avecMigrate(async (c) => {
      await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'incidents')", [f.entrepriseA])
      await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
    })
    declarant = await session(declarantId)
    responsable = await session(responsableId)
    consultant = await session(f.consultantC1, f.entrepriseA)
  })

  it('un déclarant déclare (nominative et anonyme), reçoit une référence, et un rejeu hors ligne ne duplique rien', async () => {
    const cleClient = randomUUID()
    const r1 = await traiterDeclaration(req('POST', faits({ cleClient, saisiHorsLigne: true }), declarant))
    expect(r1.status).toBe(201)
    nominative = (await corps(r1)) as typeof nominative
    expect(nominative.reference).toMatch(/^INC-\d{4}-\d{4}$/)
    const rejeu = await corps(await traiterDeclaration(req('POST', faits({ cleClient, saisiHorsLigne: true }), declarant)))
    expect(rejeu).toEqual(nominative)

    const r2 = await traiterDeclaration(req('POST', faits({ anonyme: true, description: 'Fuite d’huile non signalée' }), declarant))
    expect(r2.status).toBe(201)
    anonyme = (await corps(r2)) as typeof anonyme
  })

  it('validation : type, description et date futures refusés', async () => {
    expect((await traiterDeclaration(req('POST', faits({ type: 'autre' }), declarant))).status).toBe(400)
    expect((await traiterDeclaration(req('POST', faits({ description: '  ' }), declarant))).status).toBe(400)
    expect((await traiterDeclaration(req('POST', faits({ survenuLe: new Date(Date.now() + 5 * 86_400_000).toISOString() }), declarant))).status).toBe(400)
    expect((await traiterDeclaration(req('POST', faits({ type: 'accident_avec_arret', arretTravail: false }), declarant))).status).toBe(400)
  })

  it('le déclarant ne relit que sa déclaration nominative ; le responsable et l’équipe voient tout', async () => {
    const ids = async (jeton: string) => (await corps(await traiterListe(req('GET', undefined, jeton)))).declarations.map((d: any) => d.id)
    expect(await ids(declarant)).toContain(nominative.id)
    expect(await ids(declarant)).not.toContain(anonyme.id)
    expect(await ids(responsable)).toEqual(expect.arrayContaining([nominative.id, anonyme.id]))
    expect(await ids(consultant)).toEqual(expect.arrayContaining([nominative.id, anonyme.id]))
    expect((await traiterDetail(req('GET', undefined, declarant), anonyme.id)).status).toBe(404)
    const detail = (await corps(await traiterDetail(req('GET', undefined, responsable), anonyme.id))).declaration
    expect(detail.declarant_nom).toBeNull() // anonymat : aucun nom de déclarant, même pour le responsable
    expect(detail.anonyme).toBe(true)
  })

  it('le contexte indique les droits : équipe / responsable / simple déclarant', async () => {
    expect(await corps(await traiterContexteRegistre(req('GET', undefined, declarant)))).toMatchObject({ equipe: false, responsable: false })
    expect(await corps(await traiterContexteRegistre(req('GET', undefined, responsable)))).toMatchObject({ equipe: false, responsable: true })
    expect(await corps(await traiterContexteRegistre(req('GET', undefined, consultant)))).toMatchObject({ equipe: true })
  })

  it('qualifier, analyser, commenter, créer des actions : refusé (403) au déclarant comme au responsable client', async () => {
    for (const jeton of [declarant, responsable]) {
      expect((await traiterModification(req('PATCH', { gravite: 2, frequence: 2, statut: 'en_analyse' }, jeton), nominative.id)).status).toBe(403)
      expect((await traiterCommentaire(req('POST', { commentaire: 'x' }, jeton), nominative.id)).status).toBe(403)
      expect((await traiterAnalyse(req('PUT', { methode: 'libre', etapes: [] }, jeton), nominative.id)).status).toBe(403)
      expect((await traiterCreationAction(req('POST', { libelle: 'x' }, jeton), nominative.id)).status).toBe(403)
    }
  })

  it('l’équipe qualifie, analyse, trace, planifie et vérifie ; les faits se figent ; la clôture attend les actions', async () => {
    expect((await traiterModification(req('PATCH', { statut: 'en_analyse' }, consultant), nominative.id)).status).toBe(409) // gravité/fréquence requises
    expect((await traiterModification(req('PATCH', { description: 'corrigée', gravite: 2, frequence: 3, statut: 'en_analyse' }, consultant), nominative.id)).status).toBe(200)
    const apres = (await corps(await traiterDetail(req('GET', undefined, consultant), nominative.id))).declaration
    expect(apres).toMatchObject({ statut: 'en_analyse', criticite: 6, description: 'corrigée' })
    expect((await traiterModification(req('PATCH', { description: 'réécrite' }, consultant), nominative.id)).status).toBe(409) // faits figés

    expect((await traiterCommentaire(req('POST', { commentaire: 'Précision obtenue sur place' }, consultant), nominative.id)).status).toBe(201)
    expect((await traiterAnalyse(req('PUT', { methode: 'cinq_pourquoi', etapes: [{ question: 'Pourquoi ?', reponse: 'Rack mal fixé' }], causesProfondes: ['Absence de contrôle'] }, consultant), nominative.id)).status).toBe(200)
    expect((await traiterAnalyse(req('PUT', { methode: 'cinq_pourquoi', etapes: [{ question: '' }] }, consultant), nominative.id)).status).toBe(400)

    const action = await corps(await traiterCreationAction(req('POST', { libelle: 'Fixer les racks', nature: 'protection_collective', responsable: 'Chef atelier', echeance: '2099-01-01' }, consultant), nominative.id))
    expect(action.reference).toMatch(/^PA-/)
    expect((await traiterModification(req('PATCH', { statut: 'cloturee' }, consultant), nominative.id)).status).toBe(409) // action ouverte
    expect((await traiterStatutAction(req('PATCH', { statut: 'verifiee' }, consultant), action.id)).status).toBe(400) // résultat d'efficacité requis
    expect((await traiterStatutAction(req('PATCH', { statut: 'realisee' }, consultant), action.id)).status).toBe(200)
    expect((await traiterStatutAction(req('PATCH', { statut: 'verifiee', efficace: true, commentaire: 'Contrôlé' }, consultant), action.id)).status).toBe(200)
    expect((await traiterModification(req('PATCH', { statut: 'cloturee' }, consultant), nominative.id)).status).toBe(200)

    const detail = (await corps(await traiterDetail(req('GET', undefined, consultant), nominative.id))).declaration
    expect(detail.historique.map((h: any) => `${h.statut_avant ?? '∅'}→${h.statut_apres}`)).toEqual(['∅→a_qualifier', 'a_qualifier→en_analyse', 'en_analyse→en_analyse', 'en_analyse→cloturee'])
    expect(detail.analyse).toMatchObject({ methode: 'cinq_pourquoi', causes_profondes: ['Absence de contrôle'] })
    expect(detail.actions[0]).toMatchObject({ statut: 'verifiee', efficace: true })
    expect((await traiterModification(req('PATCH', { gravite: 1 }, consultant), nominative.id)).status).toBe(409) // close = figée

    // Le responsable client lit analyse et actions ; le déclarant ne voit que sa déclaration.
    const vuResp = (await corps(await traiterDetail(req('GET', undefined, responsable), nominative.id))).declaration
    expect(vuResp.actions).toHaveLength(1)
    const vuDecl = (await corps(await traiterDetail(req('GET', undefined, declarant), nominative.id))).declaration
    expect(vuDecl.historique).toEqual([])
    expect(vuDecl.actions).toEqual([])
    expect(vuDecl.analyse).toBeNull()
  })

  it('photos : le déclarant joint à sa déclaration anonyme sans pouvoir la relire ; le responsable la lit ; seul l’équipe supprime', async () => {
    const r = await traiterAjoutPiece(reqPhoto(declarant), anonyme.id)
    expect(r.status).toBe(201)
    const { id: fichierId } = await corps(r)
    expect((await traiterLecturePiece(req('GET', undefined, declarant), fichierId)).status).toBe(404) // anonymat : pas de relecture par l'auteur
    const lue = await traiterLecturePiece(req('GET', undefined, responsable), fichierId)
    expect(lue.status).toBe(200)
    expect(lue.headers.get('content-type')).toBe('image/png')
    const televerse = await avecMigrate((c) => c.query('SELECT televerse_par FROM fichier WHERE id = $1', [fichierId]))
    expect(televerse.rows[0].televerse_par).toBeNull() // la colonne ne désanonymise pas la photo
    const detail = (await corps(await traiterDetail(req('GET', undefined, responsable), anonyme.id))).declaration
    expect(detail.pieces).toHaveLength(1)

    expect((await traiterSuppressionPiece(req('DELETE', undefined, declarant), fichierId)).status).toBe(403)
    expect((await traiterSuppressionPiece(req('DELETE', undefined, responsable), fichierId)).status).toBe(403)
    expect((await traiterSuppressionPiece(req('DELETE', undefined, consultant), fichierId)).status).toBe(200)
    expect((await traiterLecturePiece(req('GET', undefined, responsable), fichierId)).status).toBe(404)
  })

  it('photos : un fichier qui n’est pas une image est refusé, et plus aucune pièce après qualification pour un déclarant', async () => {
    const faux = new FormData()
    faux.append('photo', new File([new TextEncoder().encode('<html>pas une image</html>')], 'a.png', { type: 'image/png' }))
    const jetons = { headers: { host: HOTE, origin: ORIGINE, 'x-forwarded-for': ip(), cookie: `ifecarm_session=${encodeURIComponent(declarant)}` } }
    const nouvelle = await corps(await traiterDeclaration(req('POST', faits(), declarant)))
    expect((await traiterAjoutPiece(new Request(`${ORIGINE}/x`, { method: 'POST', body: faux, ...jetons }), nouvelle.id)).status).toBe(400)
    expect((await traiterModification(req('PATCH', { gravite: 1, frequence: 1, statut: 'en_action' }, consultant), nouvelle.id)).status).toBe(200)
    expect((await traiterAjoutPiece(reqPhoto(declarant), nouvelle.id)).status).toBe(409)
  })

  it('résumé du tableau de bord : responsables et équipe seulement, chiffres justes, les plus critiques d’abord', async () => {
    expect((await traiterResumeRegistre(req('GET', undefined, declarant))).status).toBe(403)
    const critique = (await corps(await traiterDeclaration(req('POST', faits({ description: 'Critique du résumé' }), declarant)))) as { id: string, reference: string }
    expect((await traiterModification(req('PATCH', { gravite: 4, frequence: 4, statut: 'en_analyse' }, consultant), critique.id)).status).toBe(200)
    await traiterCreationAction(req('POST', { libelle: 'Action en retard du résumé', echeance: '2020-01-01' }, consultant), critique.id)
    await traiterDeclaration(req('POST', faits({ description: 'À qualifier du résumé' }), declarant))
    for (const jeton of [responsable, consultant]) {
      const r = await traiterResumeRegistre(req('GET', undefined, jeton))
      expect(r.status).toBe(200)
      const resume = await corps(r)
      expect(resume.ouvertes).toBeGreaterThanOrEqual(2)
      expect(resume.a_qualifier).toBeGreaterThanOrEqual(1)
      expect(resume.par_gravite[3]).toBeGreaterThanOrEqual(1)
      expect(resume.actions_en_retard).toBeGreaterThanOrEqual(1)
      expect(resume.a_traiter.length).toBeLessThanOrEqual(5)
      expect(resume.a_traiter.map((d: any) => d.criticite ?? 99)).toEqual([...resume.a_traiter.map((d: any) => d.criticite ?? 99)].sort((a: number, b: number) => b - a)) // « à qualifier » (sans criticité) d'abord, puis du plus critique au moins critique
      expect(resume.a_traiter.some((d: any) => d.reference === critique.reference && d.criticite === 16)).toBe(true)
    }

    // « Relancée le… » : après la relance quotidienne, responsables et équipe voient la date ; le déclarant ne voit rien.
    await avecMigrate((c) => c.query('SELECT relancer_actions_en_retard($1)', [f.entrepriseA]))
    for (const jeton of [responsable, consultant]) {
      const detail = (await corps(await traiterDetail(req('GET', undefined, jeton), critique.id))).declaration
      expect(detail.actions.find((x: any) => x.libelle === 'Action en retard du résumé').derniere_relance).toBeTruthy()
    }
    await avecMigrate((c) => c.query('DELETE FROM notification WHERE entreprise_id = $1 AND sujet LIKE $2', [f.entrepriseA, 'Action en retard%']))
  })

  it('responsable de site : déclaration, analyse et actions de son site, jamais l’anonyme ni l’historique', async () => {
    const { siteX, respSite } = await avecMigrate(async (c) => {
      const sx = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site route X') RETURNING id", [f.entrepriseA])).rows[0].id
      const hash = (await c.query('SELECT mot_de_passe_hash FROM utilisateur WHERE id = $1', [f.utilisateurA1])).rows[0].mot_de_passe_hash
      const email = `respsite-${randomUUID().slice(0, 8)}@test.local`
      const u = (await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.entrepriseA, email, 'Resp site', hash])).rows[0].id
      await c.query("INSERT INTO role_utilisateur (utilisateur_id, role, site_id) VALUES ($1, 'responsable_site', $2)", [u, sx])
      emails.set(u, email)
      return { siteX: sx as string, respSite: u as string }
    })
    const jeton = await session(respSite)
    const visible = await corps(await traiterDeclaration(req('POST', faits({ siteId: siteX, description: 'Sur le site X' }), declarant))) as { id: string }
    const cachee = await corps(await traiterDeclaration(req('POST', faits({ siteId: siteX, anonyme: true, description: 'Anonyme du site X' }), declarant))) as { id: string }
    await traiterAnalyse(req('PUT', { methode: 'libre', etapes: [{ texte: 'Cause X' }] }, consultant), visible.id)
    await traiterCreationAction(req('POST', { libelle: 'Action du site X' }, consultant), visible.id)
    expect(await corps(await traiterContexteRegistre(req('GET', undefined, jeton)))).toMatchObject({ equipe: false, responsable: false, responsableSite: true })

    const ids = (await corps(await traiterListe(req('GET', undefined, jeton)))).declarations.map((d: any) => d.id)
    expect(ids).toContain(visible.id)
    expect(ids).not.toContain(cachee.id)
    const detail = (await corps(await traiterDetail(req('GET', undefined, jeton), visible.id))).declaration
    expect(detail.analyse).toMatchObject({ methode: 'libre' })
    expect(detail.actions).toHaveLength(1)
    expect(detail.actions[0].derniere_relance).toBeNull()
    expect(detail.historique).toEqual([])
    expect((await traiterDetail(req('GET', undefined, jeton), cachee.id)).status).toBe(404)
    expect((await traiterResumeRegistre(req('GET', undefined, jeton))).status).toBe(403) // le résumé reste aux responsables et à l'équipe
    expect((await traiterModification(req('PATCH', { gravite: 1, frequence: 1, statut: 'en_analyse' }, jeton), visible.id)).status).toBe(403)
  })
})
