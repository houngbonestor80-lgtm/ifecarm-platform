import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import {
  traiterAjoutJustificatif, traiterAttestationsSalarie, traiterCatalogueHabilitations, traiterContexteHabilitations, traiterCreationHabilitation,
  traiterCreationSalarie, traiterCreationType, traiterCreationTypeCatalogue, traiterFicheSalarie, traiterLectureJustificatif, traiterMatrice,
  traiterModificationHabilitation, traiterModificationType, traiterModificationTypeCatalogue, traiterRenouvellement, traiterResumeHabilitations,
  traiterSuppressionHabilitation, traiterSuppressionJustificatif,
} from '@/habilitations/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Routes B4 de bout en bout (vraie session → avecTenant → module « habilitations » → RLS) : module requis, droits par
 * rôle, création (validité par défaut, attestation), renouvellement, statuts, suppression, justificatif, résumé, catalogue.
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')

let f: Fixtures
let ff: FixturesFormations
let declarantId: string
let qhseId: string
let respSiteId: string
let siteX: string
let salarieX: string
let typeA: string
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
function reqFichier(jeton: string, octets: Uint8Array, nom = 'titre.pdf'): Request {
  const form = new FormData()
  form.append('fichier', new File([octets as Uint8Array<ArrayBuffer>], nom))
  return new Request(`${ORIGINE}/api/x`, { method: 'POST', headers: { host: HOTE, 'x-forwarded-for': ip(), origin: ORIGINE, cookie: `ifecarm_session=${encodeURIComponent(jeton)}` }, body: form })
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
const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const code = () => `R${randomUUID().slice(0, 6).toUpperCase()}`

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
  await avecMigrate(async (c) => {
    const hash = (await c.query('SELECT mot_de_passe_hash FROM utilisateur WHERE id = $1', [f.utilisateurA1])).rows[0].mot_de_passe_hash
    const creer = async (label: string, role: string, site?: string) => {
      const email = `${label}-${randomUUID().slice(0, 8)}@test.local`
      const id = (await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.entrepriseA, email, label, hash])).rows[0].id
      await c.query('INSERT INTO role_utilisateur (utilisateur_id, role, site_id) VALUES ($1, $2, $3)', [id, role, site ?? null])
      emails.set(id, email)
      return id as string
    }
    siteX = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site hab route') RETURNING id", [f.entrepriseA])).rows[0].id
    salarieX = (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom, site_id) VALUES ($1, 'Soudeur', 'Koffi', $2) RETURNING id", [f.entrepriseA, siteX])).rows[0].id
    declarantId = await creer('declarant', 'declarant')
    qhseId = await creer('qhse', 'responsable_qhse')
    respSiteId = await creer('respsite', 'responsable_site', siteX)
    typeA = (await c.query("INSERT INTO type_habilitation (entreprise_id, code, intitule, domaine, validite_mois) VALUES ($1, $2, 'Habilitation test A', 'electrique', 36) RETURNING id", [f.entrepriseA, code()])).rows[0].id
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, f.consultantC1, f.adminPlateformeP1]])
    rows.forEach((r) => emails.set(r.id, r.email))
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Module « habilitations » requis', () => {
  it('sans module actif : 403, consultant compris', async () => {
    const equipe = await session(f.consultantC1, f.entrepriseA)
    expect((await traiterMatrice(req('GET', undefined, equipe))).status).toBe(403)
    expect((await traiterCreationHabilitation(req('POST', {}, equipe))).status).toBe(403)
  })
})

describe('Habilitations (entreprise A)', () => {
  let equipe: string
  let qhse: string
  let respSite: string
  let declarant: string
  let admin: string

  beforeAll(async () => {
    await avecMigrate((c) => c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'habilitations')", [f.entrepriseA]))
    equipe = await session(f.consultantC1, f.entrepriseA)
    qhse = await session(qhseId)
    respSite = await session(respSiteId)
    declarant = await session(declarantId)
    admin = await session(f.adminPlateformeP1)
  })

  const creer = (extra: Record<string, unknown> = {}, jeton = equipe) =>
    traiterCreationHabilitation(req('POST', { salarieId: f.salarieA1, typeId: typeA, dateDelivrance: jour(-30), ...extra }, jeton))

  it('droits : le déclarant est refusé partout ; le responsable QHSE lit sans écrire ; le responsable de site ne lit que son site', async () => {
    expect((await traiterMatrice(req('GET', undefined, declarant))).status).toBe(403)
    expect((await traiterContexteHabilitations(req('GET', undefined, declarant))).status).toBe(403)
    expect((await traiterMatrice(req('GET', undefined, qhse))).status).toBe(200)
    expect((await creer({}, qhse)).status).toBe(403)
    expect((await creer({}, respSite)).status).toBe(403)
    expect((await traiterCreationSalarie(req('POST', { nom: 'X', prenom: 'Y' }, qhse))).status).toBe(403)
    expect(await corps(await traiterContexteHabilitations(req('GET', undefined, equipe)))).toMatchObject({ equipe: true, responsable: false })
    expect(await corps(await traiterContexteHabilitations(req('GET', undefined, qhse)))).toMatchObject({ equipe: false, responsable: true })
  })

  it('création : validité par défaut = délivrance + durée du type ; sans échéance explicite ; attestation B2 ; doublon refusé ; date future refusée', async () => {
    const r1 = await creer({ niveau: 'B2V', referenceTitre: 'REF-1', delivrePar: 'Organisme X' })
    expect(r1.status).toBe(201)
    const { id } = await corps(r1)
    const ligne = await avecMigrate(async (c) => (await c.query('SELECT date_delivrance::text AS d, date_validite::text AS v, cree_par FROM habilitation WHERE id = $1', [id])).rows[0])
    const attendue = new Date(`${jour(-30)}T00:00:00Z`); attendue.setUTCMonth(attendue.getUTCMonth() + 36)
    expect(ligne.v).toBe(attendue.toISOString().slice(0, 10))
    expect(ligne.cree_par).toBe(f.consultantC1)

    expect((await creer({ niveau: 'B2V' })).status).toBe(409) // même salarié, type et niveau en cours
    expect((await creer({ niveau: 'sans-echeance', dateValidite: null })).status).toBe(201)
    expect((await creer({ niveau: 'futur', dateDelivrance: jour(5) })).status).toBe(400)
    expect((await creer({ niveau: 'incoherent', dateValidite: jour(-90) })).status).toBe(400)

    const att = (await corps(await traiterAttestationsSalarie(req('GET', undefined, equipe), f.salarieA1))).attestations
    expect(att.map((a: any) => a.id)).toContain(ff.attestationA)
    const r2 = await creer({ niveau: 'avec attestation', attestationId: ff.attestationA })
    expect(r2.status).toBe(201)
    const l2 = await avecMigrate(async (c) => (await c.query('SELECT h.date_validite::text AS v, a.expire_le::text AS e FROM habilitation h JOIN attestation a ON a.id = h.attestation_id WHERE h.id = $1', [(await corps(r2)).id])).rows[0])
    expect(l2.v).toBe(l2.e) // reprise de l'échéance de l'attestation
    expect((await creer({ salarieId: salarieX, niveau: 'autre salarie', attestationId: ff.attestationA })).status).toBe(409) // attestation d'un autre salarié
  })

  it('matrice : titres en cours par salarié et par type ; le responsable de site ne voit que les salariés de son site', async () => {
    await creer({ salarieId: salarieX, niveau: 'site X' })
    const m = await corps(await traiterMatrice(req('GET', undefined, equipe)))
    expect(m.salaries.map((s: any) => s.id)).toEqual(expect.arrayContaining([f.salarieA1, salarieX]))
    expect(m.titres.find((t: any) => t.salarie_id === salarieX && t.niveau === 'site X')).toMatchObject({ etat: 'valide', statut: 'active' })
    const mSite = await corps(await traiterMatrice(req('GET', undefined, respSite)))
    expect(mSite.titres.every((t: any) => t.salarie_id === salarieX)).toBe(true)
    expect(mSite.titres.length).toBeGreaterThan(0)
    expect(mSite.salaries.map((x: any) => x.id)).toEqual([salarieX]) // ni les noms des autres salariés
    expect((await traiterFicheSalarie(req('GET', undefined, respSite), f.salarieA1)).status).toBe(404)
    expect((await traiterFicheSalarie(req('GET', undefined, respSite), salarieX)).status).toBe(200)
    expect((await corps(await traiterMatrice(req('GET', undefined, qhse)))).salaries.length).toBeGreaterThan(1) // le responsable QHSE voit tout le monde
  })

  it('renouvellement : l’ancien titre est remplacé, le nouveau le référence, l’historique reste ; on ne renouvelle pas un titre remplacé', async () => {
    const { id: ancien } = await corps(await creer({ niveau: 'a-renouveler', dateValidite: jour(15) }))
    const r = await traiterRenouvellement(req('POST', { dateDelivrance: jour(-1), dateValidite: jour(1000) }, equipe), ancien)
    expect(r.status).toBe(201)
    const { id: nouveau } = await corps(r)
    const fiche = await corps(await traiterFicheSalarie(req('GET', undefined, equipe), f.salarieA1))
    const lignes = fiche.titres.filter((t: any) => t.niveau === 'a-renouveler')
    expect(lignes.find((t: any) => t.id === ancien)).toMatchObject({ statut: 'remplacee', etat: 'remplacee' })
    expect(lignes.find((t: any) => t.id === nouveau)).toMatchObject({ statut: 'active', renouvelle_id: ancien })
    expect((await traiterRenouvellement(req('POST', { dateDelivrance: jour(-1) }, equipe), ancien)).status).toBe(409)
    expect((await traiterModificationHabilitation(req('PATCH', { commentaire: 'x' }, equipe), ancien)).status).toBe(409) // figé
  })

  it('statuts : motif obligatoire, réactivation, retrait définitif ; « remplacée » ne se pose pas à la main', async () => {
    const { id } = await corps(await creer({ niveau: 'statuts' }))
    const patch = (c: Record<string, unknown>) => traiterModificationHabilitation(req('PATCH', c, equipe), id)
    expect((await patch({ statut: 'suspendue' })).status).toBe(400)
    expect((await patch({ statut: 'remplacee' })).status).toBe(400)
    expect((await patch({ statut: 'suspendue', motif: 'Visite médicale en attente' })).status).toBe(200)
    expect((await patch({ statut: 'active' })).status).toBe(200)
    expect((await patch({ referenceTitre: 'CORRIGEE', commentaire: 'Titre relu' })).status).toBe(200)
    expect((await patch({ statut: 'retiree', motif: 'Saisie par erreur' })).status).toBe(200)
    expect((await patch({ statut: 'active' })).status).toBe(409)
  })

  it('suppression : l’équipe supprime ; le client ne peut pas ; supprimer seulement le successeur d’un titre remplacé est refusé', async () => {
    const { id } = await corps(await creer({ niveau: 'a-supprimer' }))
    expect((await traiterSuppressionHabilitation(req('DELETE', undefined, qhse), id)).status).toBe(403)
    expect((await traiterSuppressionHabilitation(req('DELETE', undefined, equipe), id)).status).toBe(200)
    expect((await traiterSuppressionHabilitation(req('DELETE', undefined, equipe), id)).status).toBe(404)

    const { id: ancien } = await corps(await creer({ niveau: 'successeur' }))
    const { id: nouveau } = await corps(await traiterRenouvellement(req('POST', { dateDelivrance: jour(-1) }, equipe), ancien))
    expect((await traiterSuppressionHabilitation(req('DELETE', undefined, equipe), nouveau)).status).toBe(409)
  })

  it('justificatif : PDF ou image vérifiés sur les octets ; lisible des responsables ; invisible hors périmètre ; remplacé par un nouvel envoi', async () => {
    const { id } = await corps(await creer({ salarieId: salarieX, niveau: 'justificatif' }))
    expect((await traiterAjoutJustificatif(reqFichier(equipe, new TextEncoder().encode('<html>pas un titre</html>'), 'faux.pdf'), id)).status).toBe(400)
    const r = await traiterAjoutJustificatif(reqFichier(equipe, PDF), id)
    expect(r.status).toBe(201)
    const { id: fichier1 } = await corps(r)
    const lu = await traiterLectureJustificatif(req('GET', undefined, qhse), fichier1)
    expect(lu.status).toBe(200)
    expect(lu.headers.get('content-type')).toBe('application/pdf')
    expect((await traiterLectureJustificatif(req('GET', undefined, respSite), fichier1)).status).toBe(200) // salarié de son site
    expect((await traiterLectureJustificatif(req('GET', undefined, declarant), fichier1)).status).toBe(403)
    expect((await traiterAjoutJustificatif(reqFichier(qhse, PDF), id)).status).toBe(403)

    const { id: fichier2 } = await corps(await traiterAjoutJustificatif(reqFichier(equipe, PDF, 'titre-v2.pdf'), id))
    expect((await traiterLectureJustificatif(req('GET', undefined, qhse), fichier1)).status).toBe(404) // remplacé
    expect((await traiterLectureJustificatif(req('GET', undefined, qhse), fichier2)).status).toBe(200)
    expect((await traiterSuppressionJustificatif(req('DELETE', undefined, qhse), fichier2)).status).toBe(403)
    expect((await traiterSuppressionJustificatif(req('DELETE', undefined, equipe), fichier2)).status).toBe(200)
    const lien = await avecMigrate(async (c) => (await c.query('SELECT fichier_id FROM habilitation WHERE id = $1', [id])).rows[0].fichier_id)
    expect(lien).toBeNull()
  })

  it('résumé du tableau de bord : équipe et responsables ; refusé au responsable de site et au déclarant', async () => {
    await creer({ salarieId: salarieX, niveau: 'resume-urgent', dateValidite: jour(10) })
    for (const jeton of [equipe, qhse]) {
      const r = await traiterResumeHabilitations(req('GET', undefined, jeton))
      expect(r.status).toBe(200)
      const resume = await corps(r)
      expect(resume.a_renouveler).toBeGreaterThanOrEqual(1)
      expect(resume.urgentes).toBeGreaterThanOrEqual(1)
      expect(resume.a_traiter.length).toBeLessThanOrEqual(5)
      expect(resume.a_traiter.map((x: any) => x.jours_restants)).toEqual([...resume.a_traiter.map((x: any) => x.jours_restants)].sort((a: number, b: number) => a - b))
    }
    expect((await traiterResumeHabilitations(req('GET', undefined, respSite))).status).toBe(403)
    expect((await traiterResumeHabilitations(req('GET', undefined, declarant))).status).toBe(403)
  })

  it('types : l’équipe crée ceux de son client, pas ceux du catalogue ; le catalogue relève de l’administrateur seul', async () => {
    const r = await traiterCreationType(req('POST', { code: code(), intitule: 'Type client', domaine: 'autre', validiteMois: 12 }, equipe))
    expect(r.status).toBe(201)
    const { id } = await corps(r)
    expect((await traiterModificationType(req('PATCH', { validiteMois: 24 }, equipe), id)).status).toBe(200)
    expect((await traiterCreationType(req('POST', { code: code(), intitule: 'x', domaine: 'inconnu' }, equipe))).status).toBe(400)
    expect((await traiterCreationType(req('POST', { code: code(), intitule: 'x', domaine: 'autre' }, qhse))).status).toBe(403)

    expect((await traiterCatalogueHabilitations(req('GET', undefined, equipe))).status).toBe(403)
    expect((await traiterCreationTypeCatalogue(req('POST', { code: code(), intitule: 'x', domaine: 'autre' }, equipe))).status).toBe(403)
    const codeCat = code()
    const c = await traiterCreationTypeCatalogue(req('POST', { code: codeCat, intitule: 'Catalogue test routes', domaine: 'hauteur', validiteMois: 36, referentiel: 'Test' }, admin))
    expect(c.status).toBe(201)
    const { id: idCat } = await corps(c)
    expect((await traiterCreationTypeCatalogue(req('POST', { code: codeCat.toLowerCase(), intitule: 'Doublon', domaine: 'autre' }, admin))).status).toBe(409)
    expect((await traiterModificationTypeCatalogue(req('PATCH', { validiteMois: 48, actif: false }, admin), idCat)).status).toBe(200)
    expect((await corps(await traiterCatalogueHabilitations(req('GET', undefined, admin)))).types.find((t: any) => t.id === idCat)).toMatchObject({ validite_mois: 48, actif: false })
    expect((await traiterModificationType(req('PATCH', { validiteMois: 6 }, equipe), idCat)).status).toBe(404) // le catalogue n'est pas modifiable côté client
    await avecMigrate((cl) => cl.query('DELETE FROM type_habilitation WHERE id = $1', [idCat]))
  })
})
