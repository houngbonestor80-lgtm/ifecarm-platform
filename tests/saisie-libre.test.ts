import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import { traiterCreationSession } from '@/formations/routes'
import { traiterCreationHabilitation, traiterCreationSalarie } from '@/habilitations/routes'
import { traiterCreation } from '@/inspections/routes'
import { traiterLectureSouhaits, traiterModificationSouhaits } from '@/suivi/routes'
import { libererA2f } from './aide-a2f'
import { corpsConnexion, creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Saisie libre : le consultant n'est pas limité aux listes par défaut.
 *   - session de formation HORS catalogue (formation propre à l'entreprise, réutilisée si l'intitulé existe déjà) ;
 *   - type d'habilitation écrit à la main (type propre à l'entreprise, jamais un doublon du catalogue).
 * Le client (consultation seule) n'y a pas accès ; une autre entreprise ne voit pas ces créations.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
const emails = new Map<string, string>()
let consultant: string
let clientA: string
let salarie: string

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
    body: corpsConnexion(emails.get(id)),
  }))
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  if (entrepriseId) expect((await traiterChoixEntreprise(req('POST', jeton, { entrepriseId }))).status).toBe(200)
  return jeton
}

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.consultantC1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'formations'), ($1, 'habilitations'), ($1, 'inspections')", [f.entrepriseA])
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
  })
  consultant = await session(f.consultantC1, f.entrepriseA)
  clientA = await session(f.utilisateurA1)
  const r = await traiterCreationSalarie(req('POST', consultant, { nom: 'Libre', prenom: 'Saisie' }))
  expect(r.status, await r.clone().text()).toBe(201)
  salarie = ((await r.json()) as { id: string }).id
})

afterAll(async () => { try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ } })

const session2 = (corps: Record<string, unknown>, jeton = consultant) => traiterCreationSession(req('POST', jeton, {
  dateDebut: '2026-11-03', dateFin: '2026-11-04', dureeHeures: 14, ...corps,
}))

describe('Session de formation hors catalogue', () => {
  it('le consultant écrit l’intitulé : une formation propre à l’entreprise est créée et la session s’y rattache', async () => {
    const intitule = `Gestes et postures — atelier ${randomUUID().slice(0, 5)}`
    const r = await session2({ formationSurMesure: { intitule, domaine: 'Santé au travail', validiteMois: 24 } })
    expect(r.status, await r.clone().text()).toBe(201)
    const f1 = await migrate(async (c) => (await c.query('SELECT entreprise_id, domaine, validite_mois, actif FROM formation WHERE intitule = $1', [intitule])).rows)
    expect(f1).toHaveLength(1)
    expect(f1[0]).toMatchObject({ entreprise_id: f.entrepriseA, domaine: 'Santé au travail', validite_mois: 24, actif: true })
    // Même intitulé (casse et espaces ignorés) : la formation existante est réutilisée, pas dupliquée.
    const r2 = await session2({ formationSurMesure: { intitule: `  ${intitule.toUpperCase()} ` } })
    expect(r2.status, await r2.clone().text()).toBe(201)
    expect(await migrate(async (c) => (await c.query('SELECT count(*)::int AS n FROM formation WHERE lower(intitule) = lower($1) AND entreprise_id = $2', [intitule, f.entrepriseA])).rows[0].n)).toBe(1)
  })

  it('domaine par défaut « Sur mesure » ; intitulé obligatoire ; validité entre 1 et 240 mois', async () => {
    const intitule = `Formation interne ${randomUUID().slice(0, 5)}`
    expect((await session2({ formationSurMesure: { intitule } })).status).toBe(201)
    expect(await migrate(async (c) => (await c.query('SELECT domaine FROM formation WHERE intitule = $1', [intitule])).rows[0].domaine)).toBe('Sur mesure')
    expect((await session2({ formationSurMesure: { intitule: '  ' } })).status).toBe(400)
    expect((await session2({ formationSurMesure: { intitule: 'x', validiteMois: 0 } })).status).toBe(400)
    expect((await session2({ formationSurMesure: { intitule: 'x', validiteMois: 999 } })).status).toBe(400)
  })

  it('le client n’écrit pas ; une formation sur mesure n’existe pas chez une autre entreprise', async () => {
    expect((await session2({ formationSurMesure: { intitule: 'Intrus' } }, clientA)).status).toBe(403)
    const chezB = await migrate(async (c) => (await c.query("SELECT count(*)::int AS n FROM formation WHERE entreprise_id = $1", [f.entrepriseB])).rows[0].n)
    expect(chezB).toBe(0)
  })
})

describe('Type d’habilitation écrit à la main', () => {
  const creer = (corps: Record<string, unknown>, jeton = consultant) => traiterCreationHabilitation(req('POST', jeton, { salarieId: salarie, dateDelivrance: '2026-10-01', ...corps }))

  it('un type propre à l’entreprise est créé (code généré) et le titre s’y rattache ; la validité habituelle sert au calcul', async () => {
    const intitule = `Conduite de pont roulant ${randomUUID().slice(0, 5)}`
    const r = await creer({ nouveauType: { intitule, domaine: 'conduite_levage', referentiel: 'Interne', validiteMois: 12 } })
    expect(r.status, await r.clone().text()).toBe(201)
    const t = await migrate(async (c) => (await c.query('SELECT entreprise_id, code, domaine, referentiel, validite_mois FROM type_habilitation WHERE intitule = $1', [intitule])).rows)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ entreprise_id: f.entrepriseA, domaine: 'conduite_levage', referentiel: 'Interne', validite_mois: 12 })
    expect(t[0].code).toMatch(/^CONDUITE-DE-PONT-ROULANT-[A-Z0-9-]+-[0-9A-F]{4}$/)
    const h = await migrate(async (c) => (await c.query('SELECT h.date_validite::text AS v FROM habilitation h JOIN type_habilitation t ON t.id = h.type_id WHERE t.intitule = $1', [intitule])).rows[0])
    expect(h.v).toBe('2027-10-01')
  })

  it('un intitulé déjà connu (catalogue ou entreprise) est réutilisé : aucun doublon de type', async () => {
    const intitule = `Travail sur toiture ${randomUUID().slice(0, 5)}`
    await creer({ nouveauType: { intitule } })
    await traiterCreationHabilitation(req('POST', consultant, { salarieId: salarie, dateDelivrance: '2026-10-02', nouveauType: { intitule: ` ${intitule.toLowerCase()} ` } }))
    expect(await migrate(async (c) => (await c.query('SELECT count(*)::int AS n FROM type_habilitation WHERE lower(intitule) = lower($1)', [intitule])).rows[0].n)).toBe(1)
  })

  it('intitulé obligatoire, domaine valide ; le client n’écrit pas', async () => {
    expect((await creer({ nouveauType: { intitule: ' ' } })).status).toBe(400)
    expect((await creer({ nouveauType: { intitule: 'Type étrange', domaine: 'inconnu' } })).status).toBe(400)
    expect((await creer({ nouveauType: { intitule: 'Intrus' } }, clientA)).status).toBe(403)
  })
})

describe('Souhaits écrits à la main (service et formation hors catalogue)', () => {
  const souhaits = (corps: Record<string, unknown>, jeton = consultant) => traiterModificationSouhaits(req('PUT', jeton, corps))
  const lire = async () => (await (await traiterLectureSouhaits(req('GET', consultant))).json()) as { services: string[], serviceAutre: string | null, demandes: { id: string, slug: string, intitule: string | null, session_id: string | null }[] }

  it('un autre service et une formation hors catalogue s’enregistrent, se relisent, et la demande se planifie avec une formation sur mesure', async () => {
    const intitule = `Gestes et postures en entrepôt ${randomUUID().slice(0, 5)}`
    const r = await souhaits({ services: ['formation'], serviceAutre: '  Étude de dangers  ', formations: [{ slug: 'libre-x', intitule, nb_participants: 12, note: 'sur site' }] })
    expect(r.status, await r.clone().text()).toBe(200)
    const s = await lire()
    expect(s.serviceAutre).toBe('Étude de dangers')
    expect(s.demandes).toHaveLength(1)
    expect(s.demandes[0]).toMatchObject({ intitule, session_id: null })
    expect(s.demandes[0]!.slug).toMatch(/^libre-gestes-et-postures-en-entrepot-/)

    const planifiee = await session2({ demandeId: s.demandes[0]!.id, formationSurMesure: { intitule } })
    expect(planifiee.status, await planifiee.clone().text()).toBe(201)
    expect((await lire()).demandes[0]!.session_id).toBeTruthy()
    // Une demande planifiée ne se retire pas.
    expect((await souhaits({ services: ['formation'], formations: [] })).status).toBe(409)
  })

  it('refus : formation hors catalogue sans intitulé, intitulé trop long, service trop long, formation inconnue sans intitulé ; le client n’écrit pas', async () => {
    expect((await souhaits({ services: ['formation'], formations: [{ slug: 'libre-vide', intitule: '  ' }] })).status).toBe(400)
    expect((await souhaits({ services: ['formation'], formations: [{ slug: 'libre-long', intitule: 'x'.repeat(201) }] })).status).toBe(400)
    expect((await souhaits({ services: [], serviceAutre: 'y'.repeat(301), formations: [] })).status).toBe(400)
    expect((await souhaits({ services: ['formation'], formations: [{ slug: 'formation-inventee' }] })).status).toBe(400)
    expect((await souhaits({ services: [], serviceAutre: 'Intrus', formations: [] }, clientA)).status).toBe(403)
  })
})

describe('Inspection d’un équipement écrit à la main', () => {
  it('l’équipement est créé au registre de l’entreprise puis inspecté ; désignation et type obligatoires', async () => {
    const designation = `Échelle de l'atelier ${randomUUID().slice(0, 5)}`
    const r = await traiterCreation(req('POST', consultant, { intitule: 'Contrôle libre échelle', cibleType: 'equipement', nouvelEquipement: { type: 'Échelle', designation, numeroSerie: 'SN-9' }, points: ['Montants en bon état'] }))
    expect(r.status, await r.clone().text()).toBe(201)
    const eq = await migrate(async (c) => (await c.query('SELECT entreprise_id, type, numero_serie FROM equipement WHERE designation = $1', [designation])).rows)
    expect(eq).toEqual([{ entreprise_id: f.entrepriseA, type: 'Échelle', numero_serie: 'SN-9' }])
    expect((await traiterCreation(req('POST', consultant, { intitule: 'x', cibleType: 'equipement', nouvelEquipement: { type: ' ', designation: 'y' }, points: ['a'] }))).status).toBe(400)
    expect((await traiterCreation(req('POST', clientA, { intitule: 'x', cibleType: 'equipement', nouvelEquipement: { type: 't', designation: 'y' }, points: ['a'] }))).status).toBe(403)
  })
})
