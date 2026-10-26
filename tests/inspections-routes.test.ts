import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChangementMotDePasse, traiterChoixEntreprise, traiterConnexion, traiterConversionEntreprise, traiterListeEntreprises, traiterSuppressionEntreprise } from '@/auth/routes'
import {
  traiterContexte, traiterCreation, traiterCreationProspect, traiterDetail, traiterDonneesCreation, traiterListe,
  traiterAjoutPhoto, traiterHoraire, traiterIntervenants, traiterLecturePhoto, traiterNonConformite, traiterPlanAction, traiterResultat,
  traiterRapport, traiterStatutAction, traiterSuppression, traiterSuppressionPhoto, traiterTableauDeBord, traiterTerminer, traiterVueEnsemble,
} from '@/inspections/routes'
import { traiterCreationEquipement, traiterListeEquipements, traiterModificationEquipement, traiterSuppressionEquipement } from '@/equipements/routes'
import { traiterCreationCompte, traiterListeComptes, traiterModificationCompte } from '@/acces/routes'
import { traiterCreationModele, traiterDetailModele, traiterListeModeles, traiterModificationModele, traiterSuppressionModele } from '@/modeles/routes'
import { traiterCreationPays, traiterListePays, traiterModificationPays, traiterSuppressionPays } from '@/pays/routes'
import { traiterCreationClient, traiterCreationConsultant, traiterLectureAdministration, traiterModificationConsultant, traiterModificationEntreprise, traiterSuppressionConsultant } from '@/administration/routes'
import { traiterAjoutNote, traiterLectureSouhaits, traiterListeNotes, traiterModificationSouhaits, traiterSuppressionNote } from '@/suivi/routes'
import { withTenant } from '@/db/tenant'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

/**
 * Routes du module inspections, de bout en bout avec une VRAIE session
 * (cookie → contexte → avecTenant → exigerAccesConsultant → RLS). C'est la
 * vérification « en conditions réelles » demandée : le contrôle d'accès du
 * consultant est exercé par les routes elles-mêmes, pas seulement par la
 * fonction isolée.
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
let fi: FixturesInspections
const emails = new Map<string, string>()
const prospects: string[] = []

async function avecMigrate<T>(cb: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  try {
    return await cb(client)
  } finally {
    await client.end()
  }
}

const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

function req(method: string, corps?: unknown, jeton?: string, origine: string | null = ORIGINE): Request {
  const headers: Record<string, string> = { host: HOTE, 'content-type': 'application/json', 'x-forwarded-for': ip() }
  if (origine) headers.origin = origine
  if (jeton) headers.cookie = `ifecarm_session=${encodeURIComponent(jeton)}`
  return new Request(`${ORIGINE}/api/x`, { method, headers, body: corps === undefined ? undefined : JSON.stringify(corps) })
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

beforeAll(async () => {
  f = await creerFixtures()
  fi = await creerFixturesInspections(f)
  await avecMigrate(async (c) => {
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [
      [f.utilisateurA1, f.utilisateurB1, f.consultantC1, f.adminPlateformeP1, fi.consultantLecture, fi.consultantExpire],
    ])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inspections'), ($2, 'inspections')", [f.entrepriseA, f.entrepriseB])
  })
})

afterAll(async () => {
  // La sélection du prospect est journalisée (journal_audit immuable, par
  // conception) : l'entreprise ne peut donc pas être supprimée. En production
  // on la DÉSACTIVE (migration 0010) ; ici on la désactive aussi.
  await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = ANY($1)', [prospects]))
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré, cf. tests/tenant-isolation.test.ts
  }
  try {
    await nettoyerFixturesInspections(fi)
  } catch {
    // idem
  }
})

describe('Parcours complet du consultant (accès en écriture à B)', () => {
  let jeton: string
  let inspectionId: string
  let items: { id: string, libelle: string }[]
  let ncId: string
  let actionId: string

  beforeAll(async () => {
    jeton = await session(f.consultantC1, f.entrepriseB)
  })

  it('contexte : entreprise active, consultant autorisé à conduire', async () => {
    const r = await traiterContexte(req('GET', undefined, jeton))
    expect(r.status).toBe(200)
    expect(await corps(r)).toMatchObject({ consultant: true, peutConduire: true, entreprise: { statutRelation: 'client' } })
  })

  it('données de création : le modèle du catalogue et les sites de B (jamais ceux de A)', async () => {
    const d = await corps(await traiterDonneesCreation(req('GET', undefined, jeton)))
    expect(d.modeles.map((m: any) => m.id)).toContain(fi.modeleCatalogue)
    expect(d.modeles.find((m: any) => m.id === fi.modeleCatalogue).nb_items).toBe(2)
    expect(d.sites.map((s: any) => s.id)).toEqual([fi.siteB])
  })

  it('création : les items du modèle sont copiés dans l’inspection', async () => {
    const r = await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB }, jeton))
    expect(r.status).toBe(201)
    inspectionId = (await corps(r)).id
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), inspectionId))).inspection
    expect(d.statut).toBe('en_cours')
    items = d.items
    expect(items.map((i) => i.libelle)).toEqual(['Issues de secours dégagées', 'Extincteurs vérifiés'])
  })

  it('checklist : un résultat et un commentaire s’enregistrent', async () => {
    const r = await traiterResultat(req('PATCH', { resultat: 'conforme', commentaire: 'RAS' }, jeton), inspectionId, items[0]!.id)
    expect(r.status).toBe(200)
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), inspectionId))).inspection
    expect(d.items[0]).toMatchObject({ resultat: 'conforme', commentaire: 'RAS' })
  })

  it('résultat invalide : 400', async () => {
    expect((await traiterResultat(req('PATCH', { resultat: 'bof' }, jeton), inspectionId, items[0]!.id)).status).toBe(400)
  })

  it('non-conformité sur un item : l’item passe non conforme', async () => {
    const r = await traiterNonConformite(req('POST', { itemId: items[1]!.id, gravite: 'critique', description: 'Extincteur périmé' }, jeton), inspectionId)
    expect(r.status).toBe(201)
    ncId = (await corps(r)).id
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), inspectionId))).inspection
    expect(d.items[1].resultat).toBe('non_conforme')
    expect(d.nonConformites).toHaveLength(1)
    expect(d.nonConformites[0]).toMatchObject({ gravite: 'critique', description: 'Extincteur périmé' })
  })

  it('gravité invalide : 400', async () => {
    const r = await traiterNonConformite(req('POST', { gravite: 'enorme', description: 'x' }, jeton), inspectionId)
    expect(r.status).toBe(400)
  })

  it('plan d’action rattaché à la non-conformité, avec référence et échéance', async () => {
    const r = await traiterPlanAction(req('POST', { libelle: 'Remplacer l’extincteur', responsable: 'Chef de site', echeance: '2000-01-01' }, jeton), ncId)
    expect(r.status).toBe(201)
    const a = await corps(r)
    actionId = a.id
    expect(a.reference).toMatch(/^PA-\d{4}-[0-9A-F]{6}$/)
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), inspectionId))).inspection
    expect(d.nonConformites[0].actions[0]).toMatchObject({ libelle: 'Remplacer l’extincteur', statut: 'a_faire', en_retard: true })
  })

  it('liste : compteurs de l’inspection (renseignés, NC par gravité, actions en retard)', async () => {
    const liste = (await corps(await traiterListe(req('GET', undefined, jeton)))).inspections
    const i = liste.find((x: any) => x.id === inspectionId)
    expect(i).toMatchObject({ items_total: 2, items_renseignes: 2, nc_critique: 1, actions_ouvertes: 1, actions_en_retard: 1, cible_nom: 'Site B' })
    // Aucune inspection de A dans la liste de B.
    expect(liste.map((x: any) => x.id)).not.toContain(fi.inspectionA)
  })

  it('clôture refusée tant qu’un point n’est pas renseigné, acceptée ensuite', async () => {
    await traiterResultat(req('PATCH', { resultat: null }, jeton), inspectionId, items[0]!.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), inspectionId)).status).toBe(409)
    await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), inspectionId, items[0]!.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), inspectionId)).status).toBe(200)
  })

  it('inspection clôturée : la checklist n’est plus modifiable, le plan d’action continue de vivre', async () => {
    expect((await traiterResultat(req('PATCH', { resultat: 'non_applicable' }, jeton), inspectionId, items[0]!.id)).status).toBe(409)
    expect((await traiterStatutAction(req('PATCH', { statut: 'en_cours' }, jeton), actionId)).status).toBe(200)
  })

  it('le client B consulte seulement : il voit le plan d’action mais ne peut rien modifier', async () => {
    const client = await session(f.utilisateurB1)
    expect((await traiterStatutAction(req('PATCH', { statut: 'realisee' }, client), actionId)).status).toBe(403)
    expect((await traiterStatutAction(req('PATCH', { statut: 'realisee' }, jeton), actionId)).status).toBe(200)
    const d = (await corps(await traiterDetail(req('GET', undefined, client), inspectionId))).inspection
    expect(d.nonConformites[0].actions[0]).toMatchObject({ statut: 'realisee', en_retard: false })

    expect((await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB }, client))).status).toBe(403)
    expect((await traiterNonConformite(req('POST', { gravite: 'mineure', description: 'x' }, client), inspectionId)).status).toBe(403)
    const ctx = await corps(await traiterContexte(req('GET', undefined, client)))
    expect(ctx).toMatchObject({ consultant: false, peutConduire: false })
  })

  it('statut de plan d’action invalide : 400', async () => {
    expect((await traiterStatutAction(req('PATCH', { statut: 'fini' }, jeton), actionId)).status).toBe(400)
  })
})

describe('Cloisonnement et contrôle d’accès, via les routes', () => {
  it('depuis B, l’inspection de A est introuvable (404), même avec son identifiant', async () => {
    const jeton = await session(f.consultantC1, f.entrepriseB)
    expect((await traiterDetail(req('GET', undefined, jeton), fi.inspectionA)).status).toBe(404)
    expect((await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), fi.inspectionA, fi.itemA1)).status).toBe(404)
  })

  it('créer une inspection de B sur le site de A est refusé (404)', async () => {
    const jeton = await session(f.consultantC1, f.entrepriseB)
    expect((await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteA }, jeton))).status).toBe(404)
  })

  it('consultant en lecture seule sur A : il lit, il ne conduit pas', async () => {
    const jeton = await session(fi.consultantLecture, f.entrepriseA)
    expect((await traiterListe(req('GET', undefined, jeton))).status).toBe(200)
    expect((await corps(await traiterContexte(req('GET', undefined, jeton)))).peutConduire).toBe(false)
    expect((await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteA }, jeton))).status).toBe(403)
  })

  it('mandat expiré en cours de session : la route suivante est refusée (403)', async () => {
    await avecMigrate((c) => c.query("UPDATE acces_consultant SET fin_le = CURRENT_DATE + 5 WHERE utilisateur_id = $1", [fi.consultantExpire]))
    const jeton = await session(fi.consultantExpire, f.entrepriseA)
    expect((await traiterListe(req('GET', undefined, jeton))).status).toBe(200)
    await avecMigrate((c) => c.query("UPDATE acces_consultant SET fin_le = CURRENT_DATE - 1 WHERE utilisateur_id = $1", [fi.consultantExpire]))
    expect((await traiterListe(req('GET', undefined, jeton))).status).toBe(403)
    expect((await traiterDetail(req('GET', undefined, jeton), fi.inspectionA)).status).toBe(403)
  })

  it('module inspections non souscrit : 403', async () => {
    await avecMigrate((c) => c.query("UPDATE abonnement_module SET actif = false WHERE entreprise_id = $1 AND module = 'inspections'", [f.entrepriseA]))
    try {
      const jeton = await session(f.utilisateurA1)
      expect((await traiterListe(req('GET', undefined, jeton))).status).toBe(403)
    } finally {
      await avecMigrate((c) => c.query("UPDATE abonnement_module SET actif = true WHERE entreprise_id = $1 AND module = 'inspections'", [f.entrepriseA]))
    }
  })

  it('sans session : 401 ; sans en-tête Origin sur une écriture : 403', async () => {
    expect((await traiterListe(req('GET'))).status).toBe(401)
    const jeton = await session(f.consultantC1, f.entrepriseB)
    expect((await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB }, jeton, null))).status).toBe(403)
  })
})

describe('Suppression d’une inspection (règle mixte, migration 0012)', () => {
  let jeton: string
  const nouvelle = async () => {
    const r = await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB }, jeton))
    return (await corps(r)).id as string
  }
  const journal = (id: string) => avecMigrate(async (c) =>
    (await c.query<{ action: string }>("SELECT action FROM journal_audit WHERE objet_type = 'inspection' AND objet_id = $1 ORDER BY cree_le", [id])).rows.map((r) => r.action))

  beforeAll(async () => {
    jeton = await session(f.consultantC1, f.entrepriseB)
  })

  it('en cours et sans non-conformité : supprimée définitivement, et journalisée', async () => {
    const id = await nouvelle()
    const r = await traiterSuppression(req('DELETE', undefined, jeton), id)
    expect(r.status).toBe(200)
    expect(await corps(r)).toEqual({ resultat: 'supprimee' })
    expect((await traiterDetail(req('GET', undefined, jeton), id)).status).toBe(404)
    expect(await journal(id)).toEqual(['suppression'])
  })

  it('avec une non-conformité : annulée (conservée), plus modifiable, et journalisée', async () => {
    const id = await nouvelle()
    await traiterNonConformite(req('POST', { gravite: 'mineure', description: 'Signalétique absente' }, jeton), id)
    const r = await traiterSuppression(req('DELETE', undefined, jeton), id)
    expect(await corps(r)).toEqual({ resultat: 'annulee' })
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), id))).inspection
    expect(d.statut).toBe('annulee')
    expect(d.nonConformites).toHaveLength(1)
    expect((await traiterNonConformite(req('POST', { gravite: 'mineure', description: 'x' }, jeton), id)).status).toBe(409)
    expect(await journal(id)).toEqual(['annulation'])
  })

  it('rangée puis supprimée définitivement : NC et plans d’action effacés, trace au journal (migration 0014)', async () => {
    const id = await nouvelle()
    const nc = await corps(await traiterNonConformite(req('POST', { gravite: 'majeure', description: 'Issue de secours bloquée' }, jeton), id))
    await traiterPlanAction(req('POST', { libelle: 'Dégager l’issue', responsable: 'Chef de site', echeance: '2030-01-01' }, jeton), nc.id)
    expect(await corps(await traiterSuppression(req('DELETE', undefined, jeton), id))).toEqual({ resultat: 'annulee' })
    const client = await session(f.utilisateurB1)
    expect((await traiterSuppression(req('DELETE', undefined, client), id)).status).toBe(403)

    expect(await corps(await traiterSuppression(req('DELETE', undefined, jeton), id))).toEqual({ resultat: 'purgee' })
    expect((await traiterDetail(req('GET', undefined, jeton), id)).status).toBe(404)
    const restes = await avecMigrate(async (c) => (await c.query(
      "SELECT (SELECT count(*) FROM non_conformite WHERE id = $1)::int + (SELECT count(*) FROM action_corrective WHERE origine_id = $1)::int AS n", [nc.id])).rows[0].n)
    expect(restes).toBe(0)
    expect(await journal(id)).toEqual(['annulation', 'suppression'])
  })

  it('purge refusée en base pour une inspection non rangée ou d’une autre entreprise', async () => {
    await expect(avecMigrate((c) => c.query('SELECT purger_inspection_annulee($1)', [fi.inspectionA])))
      .rejects.toThrow(/introuvable ou non rangée/)
  })

  it('clôturée, même sans non-conformité : annulée, jamais effacée', async () => {
    const id = await nouvelle()
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), id))).inspection
    for (const item of d.items) await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), id, item.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), id)).status).toBe(200)
    expect(await corps(await traiterSuppression(req('DELETE', undefined, jeton), id))).toEqual({ resultat: 'annulee' })
  })

  it('un client ne peut pas supprimer (403), ni un consultant depuis une autre entreprise (404)', async () => {
    const id = await nouvelle()
    const client = await session(f.utilisateurB1)
    expect((await traiterSuppression(req('DELETE', undefined, client), id)).status).toBe(403)
    expect((await traiterSuppression(req('DELETE', undefined, jeton), fi.inspectionA)).status).toBe(404)
    expect((await traiterSuppression(req('DELETE', undefined, jeton, null), id)).status).toBe(403)
  })

  it('garde-fou en base : une inspection clôturée ne peut pas être effacée, même directement en SQL', async () => {
    await expect(avecMigrate((c) => c.query('DELETE FROM inspection WHERE id = $1', [fi.inspectionA])))
      .rejects.toThrow(/doit d'abord être rangée/)
  })
})

describe('Intervenants et photos (migration 0013)', () => {
  let jeton: string
  let inspectionId: string
  let itemId: string
  // En-tête JPEG minimal : seul le type réel (premiers octets) est contrôlé.
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

  function reqPhoto(champs: Record<string, string>, octets: Uint8Array, jetonUtilise: string, nom = 'constat.jpg'): Request {
    const form = new FormData()
    Object.entries(champs).forEach(([k, v]) => form.append(k, v))
    form.append('photo', new File([octets as Uint8Array<ArrayBuffer>], nom, { type: 'image/jpeg' }))
    return new Request(`${ORIGINE}/api/x`, {
      method: 'POST',
      headers: { host: HOTE, origin: ORIGINE, cookie: `ifecarm_session=${encodeURIComponent(jetonUtilise)}`, 'x-forwarded-for': ip() },
      body: form,
    })
  }
  const detail = async (id: string, j = jeton) => (await corps(await traiterDetail(req('GET', undefined, j), id))).inspection

  beforeAll(async () => {
    jeton = await session(f.consultantC1, f.entrepriseB)
    const r = await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB, representantClient: 'M. Houngbo, chef de site' }, jeton))
    inspectionId = (await corps(r)).id
    itemId = (await detail(inspectionId)).items[0].id
  })

  it('création : inspecteur pré-rempli avec le nom du compte, représentant du client enregistré', async () => {
    const d = await detail(inspectionId)
    expect(d.inspecteur_nom).toBeTruthy()
    expect(d.representant_client).toBe('M. Houngbo, chef de site')
  })

  it('les noms se modifient ; un client ne peut pas les modifier', async () => {
    expect((await traiterIntervenants(req('PATCH', { inspecteurNom: 'Ing. A. Dossou' }, jeton), inspectionId)).status).toBe(200)
    expect((await detail(inspectionId)).inspecteur_nom).toBe('Ing. A. Dossou')
    const client = await session(f.utilisateurB1)
    expect((await traiterIntervenants(req('PATCH', { inspecteurNom: 'X' }, client), inspectionId)).status).toBe(403)
  })

  it('horaires : jour, heure de début et de fin décidés à la création puis modifiables ; refus si incohérents, client ou clôturée', async () => {
    const r = await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB, date: '2027-03-10', heureDebut: '08:30', heureFin: '10:00' }, jeton))
    expect(r.status).toBe(201)
    const id = (await corps(r)).id
    let d = await detail(id)
    expect([d.date_inspection, d.heure_debut, d.heure_fin]).toEqual(['2027-03-10', '08:30', '10:00'])

    // Création incohérente : fin avant début, fin sans début, format invalide.
    const mauvais = (c: Record<string, unknown>) => traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB, ...c }, jeton))
    expect((await mauvais({ heureDebut: '10:00', heureFin: '09:00' })).status).toBe(400)
    expect((await mauvais({ heureFin: '09:00' })).status).toBe(400)
    expect((await mauvais({ heureDebut: '25:00' })).status).toBe(400)

    // Modification, y compris effacement des horaires.
    const put = (c: Record<string, unknown>, j = jeton) => traiterHoraire(req('PUT', c, j), id)
    expect((await put({ date: '2027-03-11', heureDebut: '14:00', heureFin: '16:45' })).status).toBe(200)
    d = await detail(id)
    expect([d.date_inspection, d.heure_debut, d.heure_fin]).toEqual(['2027-03-11', '14:00', '16:45'])
    expect((await put({ date: '2027-03-11', heureDebut: '14:00', heureFin: '13:00' })).status).toBe(400)
    expect((await put({ date: 'demain' })).status).toBe(400)
    expect((await put({ date: '2027-03-11' })).status).toBe(200)
    d = await detail(id)
    expect([d.heure_debut, d.heure_fin]).toEqual([null, null])

    // Client : refusé. Inspection clôturée : plus modifiable.
    expect((await put({ date: '2027-03-11' }, await session(f.utilisateurB1))).status).toBe(403)
    for (const item of (await detail(id)).items) await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), id, item.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), id)).status).toBe(200)
    expect((await put({ date: '2027-03-12' })).status).toBe(409)
  })

  it('photo sur un point : ajoutée, listée, lisible par le consultant et par le client', async () => {
    const r = await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: itemId }, JPEG, jeton), inspectionId)
    expect(r.status).toBe(201)
    const photoId = (await corps(r)).id
    expect((await detail(inspectionId)).items[0].photos).toEqual([{ id: photoId, nom: 'constat.jpg' }])

    const lue = await traiterLecturePhoto(req('GET', undefined, jeton), photoId)
    expect(lue.status).toBe(200)
    expect(lue.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await lue.arrayBuffer())).toEqual(JPEG)

    const client = await session(f.utilisateurB1)
    expect((await traiterLecturePhoto(req('GET', undefined, client), photoId)).status).toBe(200)
    // Depuis A, la photo de B est introuvable.
    const autre = await session(f.utilisateurA1)
    expect((await traiterLecturePhoto(req('GET', undefined, autre), photoId)).status).toBe(404)
  })

  it('refusée : faux fichier image (400), élément d’une autre inspection (404), client (403)', async () => {
    const faux = new TextEncoder().encode('<script>alert(1)</script>')
    expect((await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: itemId }, faux, jeton, 'x.jpg'), inspectionId)).status).toBe(400)
    expect((await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: fi.itemB1 }, JPEG, jeton), inspectionId)).status).toBe(404)
    const client = await session(f.utilisateurB1)
    expect((await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: itemId }, JPEG, client), inspectionId)).status).toBe(403)
  })

  it('photo sur une non-conformité, puis suppression d’une photo', async () => {
    const nc = await corps(await traiterNonConformite(req('POST', { itemId, gravite: 'majeure', description: 'Issue encombrée' }, jeton), inspectionId))
    const r = await traiterAjoutPhoto(reqPhoto({ cible: 'nc', cibleId: nc.id }, JPEG, jeton), inspectionId)
    const photoId = (await corps(r)).id
    expect((await detail(inspectionId)).nonConformites[0].photos.map((p: any) => p.id)).toEqual([photoId])
    expect((await traiterSuppressionPhoto(req('DELETE', undefined, jeton), photoId)).status).toBe(200)
    expect((await detail(inspectionId)).nonConformites[0].photos).toEqual([])
    expect((await traiterLecturePhoto(req('GET', undefined, jeton), photoId)).status).toBe(404)
  })

  it('inspection clôturée : plus d’ajout ni de suppression de photo (409)', async () => {
    const d = await detail(inspectionId)
    for (const item of d.items) await traiterResultat(req('PATCH', { resultat: item.resultat ?? 'conforme' }, jeton), inspectionId, item.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), inspectionId)).status).toBe(200)
    expect((await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: itemId }, JPEG, jeton), inspectionId)).status).toBe(409)
    const photoId = (await detail(inspectionId)).items[0].photos[0].id
    expect((await traiterSuppressionPhoto(req('DELETE', undefined, jeton), photoId)).status).toBe(409)
  })

  it('suppression définitive d’une inspection : ses photos disparaissent aussi', async () => {
    const id = (await corps(await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB }, jeton)))).id
    const item = (await detail(id)).items[0].id
    const photoId = (await corps(await traiterAjoutPhoto(reqPhoto({ cible: 'item', cibleId: item }, JPEG, jeton), id))).id
    expect(await corps(await traiterSuppression(req('DELETE', undefined, jeton), id))).toEqual({ resultat: 'supprimee' })
    const reste = await avecMigrate(async (c) => (await c.query('SELECT 1 FROM fichier WHERE id = $1', [photoId])).rowCount)
    expect(reste).toBe(0)
  })

  it('rapport PDF : généré pour le consultant et pour le client, introuvable depuis une autre entreprise', async () => {
    const r = await traiterRapport(req('GET', undefined, jeton), inspectionId)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    const octets = new Uint8Array(await r.arrayBuffer())
    expect(new TextDecoder().decode(octets.slice(0, 5))).toBe('%PDF-')
    expect(octets.length).toBeGreaterThan(20_000) // polices + logo embarqués

    const client = await session(f.utilisateurB1)
    expect((await traiterRapport(req('GET', undefined, client), inspectionId)).status).toBe(200)
    const autre = await session(f.utilisateurA1)
    expect((await traiterRapport(req('GET', undefined, autre), inspectionId)).status).toBe(404)
  })
})

describe('Création terrain d’un prospect', () => {
  it('le consultant crée un prospect, la session bascule dessus, et il inspecte un site créé à la volée', async () => {
    const jeton = await session(f.consultantC1)
    const r = await traiterCreationProspect(req('POST', { nom: 'Prospect routes test', pays: 'BJ', secteur: 'BTP' }, jeton))
    expect(r.status).toBe(201)
    const { id } = await corps(r)
    prospects.push(id)

    const ctx = await corps(await traiterContexte(req('GET', undefined, jeton)))
    expect(ctx).toMatchObject({ entreprise: { nom: 'Prospect routes test', statutRelation: 'prospect' }, peutConduire: true })

    const creation = await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, nouveauSite: { nom: 'Chantier Akpakpa', ville: 'Cotonou' } }, jeton))
    expect(creation.status).toBe(201)
    const liste = (await corps(await traiterListe(req('GET', undefined, jeton)))).inspections
    expect(liste).toHaveLength(1)
    expect(liste[0]).toMatchObject({ cible_nom: 'Chantier Akpakpa', items_total: 2 })
  })

  it('un utilisateur client ne peut pas créer de prospect', async () => {
    const jeton = await session(f.utilisateurA1)
    expect((await traiterCreationProspect(req('POST', { nom: 'Interdit' }, jeton))).status).toBe(403)
  })

  it('nom manquant : 400', async () => {
    const jeton = await session(f.consultantC1)
    expect((await traiterCreationProspect(req('POST', { nom: '  ' }, jeton))).status).toBe(400)
  })
})

describe('Tableau de bord', () => {
  it('prospect : indicateurs, action en retard et NC ouverte ; client sans module : 403', async () => {
    const jeton = await session(f.consultantC1)
    const { id } = await corps(await traiterCreationProspect(req('POST', { nom: 'Prospect tableau', pays: 'BJ' }, jeton)))
    prospects.push(id)
    const insp = await corps(await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, nouveauSite: { nom: 'Atelier', ville: 'Cotonou' } }, jeton)))
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), insp.id))).inspection
    await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), insp.id, d.items[0].id)
    await traiterResultat(req('PATCH', { resultat: 'non_conforme' }, jeton), insp.id, d.items[1].id)
    const nc = await corps(await traiterNonConformite(req('POST', { gravite: 'critique', description: 'Tableau électrique ouvert' }, jeton), insp.id))
    await traiterPlanAction(req('POST', { libelle: 'Fermer le tableau', responsable: 'Électricien', echeance: '2000-01-01' }, jeton), nc.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), insp.id)).status).toBe(200)

    expect((await corps(await traiterContexte(req('GET', undefined, jeton)))).tableauDeBord).toBe(true)
    const r = await traiterTableauDeBord(req('GET', undefined, jeton))
    expect(r.status).toBe(200)
    const t = await corps(r)
    expect(t.indicateurs).toMatchObject({
      inspectionsTerminees90j: 1, tauxConformite90j: 0.5, ncOuvertes: { critique: 1, majeure: 0, mineure: 0 },
      actionsOuvertes: 1, actionsEnRetard: 1,
    })
    expect(t.actions).toEqual([expect.objectContaining({ libelle: 'Fermer le tableau', en_retard: true, inspection_id: insp.id })])
    expect(t.nonConformites).toEqual([expect.objectContaining({ id: nc.id, gravite: 'critique', a_une_action: true })])
    expect(t.evolution).toHaveLength(6)
    expect(t.evolution.at(-1)).toMatchObject({ inspections: 1, taux: 0.5 })

    const client = await session(f.utilisateurB1)
    expect((await traiterTableauDeBord(req('GET', undefined, client))).status).toBe(403)
  })
})

describe('Suppression définitive d’un prospect ou d’un client (migration 0015)', () => {
  const existe = (id: string) => avecMigrate(async (c) => (await c.query('SELECT 1 FROM entreprise WHERE id = $1', [id])).rowCount)

  it('le consultant supprime son prospect, inspection clôturée et NC comprises ; le journal reste', async () => {
    const jeton = await session(f.consultantC1)
    const { id } = await corps(await traiterCreationProspect(req('POST', { nom: 'Prospect à effacer', pays: 'BJ' }, jeton)))
    const insp = await corps(await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, nouveauSite: { nom: 'Dépôt', ville: 'Cotonou' } }, jeton)))
    const nc = await corps(await traiterNonConformite(req('POST', { gravite: 'majeure', description: 'Extincteur absent' }, jeton), insp.id))
    await traiterPlanAction(req('POST', { libelle: 'Installer', responsable: 'Chef', echeance: '2030-01-01' }, jeton), nc.id)
    const d = (await corps(await traiterDetail(req('GET', undefined, jeton), insp.id))).inspection
    for (const item of d.items) await traiterResultat(req('PATCH', { resultat: 'conforme' }, jeton), insp.id, item.id)
    expect((await traiterTerminer(req('POST', undefined, jeton), insp.id)).status).toBe(200)

    const liste = (await corps(await traiterListeEntreprises(req('GET', undefined, jeton)))).entreprises
    expect(liste.find((e: any) => e.id === id)).toMatchObject({ supprimable: true })
    expect(liste.find((e: any) => e.id === f.entrepriseB)).toMatchObject({ supprimable: false })

    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: 'autre nom' }, jeton), id)).status).toBe(409)
    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: 'Prospect à effacer' }, jeton, null), id)).status).toBe(403)
    expect(await existe(id)).toBe(1)

    const r = await traiterSuppressionEntreprise(req('DELETE', { confirmation: ' prospect À EFFACER ' }, jeton), id)
    expect(r.status).toBe(200)
    expect(await existe(id)).toBe(0)
    const journal = await avecMigrate(async (c) => (await c.query<{ action: string, details: any }>(
      "SELECT action, details FROM journal_audit WHERE objet_id = $1 OR objet_id = $2 ORDER BY id", [id, insp.id])).rows)
    expect(journal.map((j) => j.action)).toEqual(expect.arrayContaining(['creer_prospect', 'suppression']))
    expect(journal.at(-1)).toMatchObject({ action: 'suppression', details: { nom: 'Prospect à effacer', statut_relation: 'prospect' } })
  })

  it('un client : refusé au consultant et à l’utilisateur client, accepté pour l’admin plateforme', async () => {
    const consultant = await session(f.consultantC1)
    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: 'x' }, consultant), f.entrepriseB)).status).toBe(403)
    const client = await session(f.utilisateurB1)
    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: 'x' }, client), f.entrepriseB)).status).toBe(403)
    expect(await existe(f.entrepriseB)).toBe(1)

    const nom = `Client jetable ${Date.now()}`
    const id = await avecMigrate(async (c) => (await c.query<{ id: string }>(
      "INSERT INTO entreprise (nom, pays, statut_relation) VALUES ($1, 'BJ', 'client') RETURNING id", [nom])).rows[0]!.id)
    const admin = await session(f.adminPlateformeP1)
    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: nom }, admin), id)).status).toBe(200)
    expect(await existe(id)).toBe(0)
    expect((await traiterSuppressionEntreprise(req('DELETE', { confirmation: 'IFECARM GROUP' }, admin), f.ifecarmInterne)).status).toBe(404)
  })

  it('le journal d’audit reste immuable hors détachement', async () => {
    await expect(avecMigrate((c) => c.query("UPDATE journal_audit SET action = 'x' WHERE id = (SELECT max(id) FROM journal_audit)")))
      .rejects.toThrow(/ni modifié ni supprimé/)
  })
})

describe('Registre des équipements et EPI (migration 0016)', () => {
  it('le consultant tient le registre ; échéances calculées ; le client consulte seulement ; cloisonné', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const liste = await corps(await traiterListeEquipements(req('GET', undefined, consultant)))
    expect(liste.peutGerer).toBe(true)

    const r = await traiterCreationEquipement(req('POST', {
      type: 'EPI', designation: 'Harnais antichute', affecteA: 'K. Dossou', periodiciteMois: '6', derniereVerif: '2026-01-15',
    }, consultant))
    expect(r.status).toBe(201)
    const { id } = await corps(r)
    const lire = async (jeton = consultant) => (await corps(await traiterListeEquipements(req('GET', undefined, jeton)))).equipements.find((e: any) => e.id === id)
    expect(await lire()).toMatchObject({ prochaine_verif: '2026-07-15', affecte_a: 'K. Dossou', inspections: 0 })

    expect((await traiterModificationEquipement(req('PATCH', { action: 'verification', date: '2026-09-01' }, consultant), id)).status).toBe(200)
    expect(await lire()).toMatchObject({ derniere_verif: '2026-09-01', prochaine_verif: '2027-03-01' })
    expect((await traiterCreationEquipement(req('POST', { type: 'EPI', designation: 'x', periodiciteMois: 500 }, consultant))).status).toBe(400)

    // Client : il voit le registre, sans pouvoir le modifier.
    const client = await session(f.utilisateurB1)
    expect((await corps(await traiterListeEquipements(req('GET', undefined, client)))).peutGerer).toBe(false)
    expect(await lire(client)).toMatchObject({ designation: 'Harnais antichute' })
    expect((await traiterCreationEquipement(req('POST', { type: 'EPI', designation: 'Casque' }, client))).status).toBe(403)
    expect((await traiterModificationEquipement(req('PATCH', { action: 'actif', actif: false }, client), id)).status).toBe(403)
    expect((await traiterSuppressionEquipement(req('DELETE', undefined, client), id)).status).toBe(403)

    // Autre entreprise : invisible et intouchable.
    const autre = await session(f.utilisateurA1)
    expect((await corps(await traiterListeEquipements(req('GET', undefined, autre)))).equipements.map((e: any) => e.id)).not.toContain(id)
    expect((await traiterModificationEquipement(req('PATCH', { action: 'actif', actif: false }, autre), id)).status).toBe(403)

    // Consultant en lecture seule : consultation uniquement.
    const lecture = await session(fi.consultantLecture, f.entrepriseA)
    expect((await corps(await traiterListeEquipements(req('GET', undefined, lecture)))).peutGerer).toBe(false)
    expect((await traiterCreationEquipement(req('POST', { type: 'EPI', designation: 'Casque' }, lecture))).status).toBe(403)

    expect((await traiterSuppressionEquipement(req('DELETE', undefined, consultant), id)).status).toBe(200)
    expect(await lire()).toBeUndefined()
  })
})

describe('Accès : comptes du client créés par le consultant (migration 0017)', () => {
  const connexion = (email: string, motDePasse: string) => traiterConnexion(req('POST', { email, motDePasse }))
  const jetonDe = (r: Response) => jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!

  it('création, connexion limitée à son entreprise, réinitialisation, désactivation', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const email = `nouveau-${Date.now()}@client.test`
    const r = await traiterCreationCompte(req('POST', { nom: 'Awa Client', email, role: 'responsable_qhse' }, consultant))
    expect(r.status).toBe(201)
    const { id, motDePasse } = await corps(r)
    expect(motDePasse).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/)
    expect((await corps(await traiterListeComptes(req('GET', undefined, consultant)))).comptes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id, email, actif: true, roles: ['responsable_qhse'] })]))

    // Il se connecte et ne voit que son entreprise.
    const c = await connexion(email, motDePasse)
    expect(c.status).toBe(200)
    const jeton = jetonDe(c)
    await libererA2f(jeton)
    expect((await corps(await traiterContexte(req('GET', undefined, jeton)))).entreprise.nom).toMatch(/^Test Cloisonnement B/)
    expect((await traiterDetail(req('GET', undefined, jeton), fi.inspectionA)).status).toBe(404)
    expect((await traiterListeComptes(req('GET', undefined, jeton))).status).toBe(403)

    expect((await traiterCreationCompte(req('POST', { nom: 'Doublon', email, role: 'declarant' }, consultant))).status).toBe(409)
    expect((await traiterCreationCompte(req('POST', { nom: 'Pirate', email: `x-${Date.now()}@t.test`, role: 'consultant_ifecarm' }, consultant))).status).toBe(400)

    const nouveau = (await corps(await traiterModificationCompte(req('PATCH', { action: 'mot_de_passe' }, consultant), id))).motDePasse
    expect((await traiterContexte(req('GET', undefined, jeton))).status).toBe(401) // sessions fermées
    expect((await connexion(email, motDePasse)).status).toBe(401)
    const jeton2 = jetonDe(await connexion(email, nouveau))

    expect((await traiterModificationCompte(req('PATCH', { actif: false }, consultant), id)).status).toBe(200)
    expect((await traiterContexte(req('GET', undefined, jeton2))).status).toBe(401)
    expect((await connexion(email, nouveau)).status).toBe(401)
  })

  it('refusé au client et au consultant en lecture seule ; rôle interne impossible même en SQL', async () => {
    const client = await session(f.utilisateurB1)
    expect((await traiterCreationCompte(req('POST', { nom: 'X', email: 'x@y.test', role: 'declarant' }, client))).status).toBe(403)
    const lecture = await session(fi.consultantLecture, f.entrepriseA)
    expect((await traiterListeComptes(req('GET', undefined, lecture))).status).toBe(403)
    await expect(avecMigrate((c) => c.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'admin_plateforme')", [f.utilisateurB1])))
      .rejects.toThrow(/réservé aux utilisateurs IFECARM GROUP/)
  })
})

describe('Gestion des modèles (admin : catalogue ; consultant : modèles de l’entreprise)', () => {
  const items = [{ libelle: 'Extincteurs accessibles', gravite: 'majeure' }, { libelle: 'Affichage consignes', aide: 'Près des sorties' }]

  it('le consultant crée, modifie, archive et supprime un modèle de son client ; cloisonné', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const r = await traiterCreationModele(req('POST', { intitule: 'Visite dépôt B', domaine: 'Incendie', cibleType: 'site', items }, consultant))
    expect(r.status).toBe(201)
    const { id } = await corps(r)

    const client = await session(f.utilisateurB1)
    const vueClient = await corps(await traiterListeModeles(req('GET', undefined, client)))
    expect(vueClient).toMatchObject({ peutGererEntreprise: false, peutGererCatalogue: false })
    expect(vueClient.modeles.find((m: any) => m.id === id)).toMatchObject({ portee: 'entreprise', nb_items: 2 })
    expect((await traiterCreationModele(req('POST', { intitule: 'x', domaine: 'x', cibleType: 'site', items }, client))).status).toBe(403)
    expect((await traiterModificationModele(req('PUT', { intitule: 'x', domaine: 'x', cibleType: 'site', items }, client), id)).status).toBe(403)

    const autre = await session(f.utilisateurA1)
    expect((await traiterDetailModele(req('GET', undefined, autre), id)).status).toBe(404)

    // Modification : ordre inversé, un point en plus.
    const nouveaux = [items[1], items[0], { libelle: 'Plan d’évacuation affiché', gravite: 'critique' }]
    expect((await traiterModificationModele(req('PUT', { intitule: 'Visite dépôt B v2', domaine: 'Incendie', cibleType: 'site', items: nouveaux }, consultant), id)).status).toBe(200)
    const m = (await corps(await traiterDetailModele(req('GET', undefined, consultant), id))).modele
    expect(m.intitule).toBe('Visite dépôt B v2')
    expect(m.items.map((i: any) => [i.libelle, i.gravite_defaut])).toEqual([
      ['Affichage consignes', 'mineure'], ['Extincteurs accessibles', 'majeure'], ['Plan d’évacuation affiché', 'critique']])

    // Utilisé par une inspection : suppression refusée, archivage possible ; l'inspection garde ses libellés.
    const insp = await corps(await traiterCreation(req('POST', { modeleId: id, siteId: fi.siteB }, consultant)))
    expect((await traiterSuppressionModele(req('DELETE', undefined, consultant), id)).status).toBe(409)
    expect((await traiterModificationModele(req('PUT', { ...m, cibleType: 'site', actif: false, items: [{ libelle: 'Autre' }] }, consultant), id)).status).toBe(200)
    const d = (await corps(await traiterDetail(req('GET', undefined, consultant), insp.id))).inspection
    expect(d.items.map((i: any) => i.libelle)).toEqual(['Affichage consignes', 'Extincteurs accessibles', 'Plan d’évacuation affiché'])
    expect((await corps(await traiterListeModeles(req('GET', undefined, client)))).modeles.find((x: any) => x.id === id)).toBeUndefined()

    const jetable = (await corps(await traiterCreationModele(req('POST', { intitule: 'Essai', domaine: 'Qualité', cibleType: 'equipement', items }, consultant)))).id
    expect((await traiterSuppressionModele(req('DELETE', undefined, consultant), jetable)).status).toBe(200)
    expect((await traiterCreationModele(req('POST', { intitule: 'Vide', domaine: 'x', cibleType: 'site', items: [] }, consultant))).status).toBe(400)
  })

  it('catalogue : refusé au consultant, géré par l’admin plateforme', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    expect((await traiterCreationModele(req('POST', { portee: 'catalogue', intitule: 'x', domaine: 'x', cibleType: 'site', items }, consultant))).status).toBe(403)
    expect((await traiterModificationModele(req('PUT', { intitule: 'x', domaine: 'x', cibleType: 'site', items }, consultant), fi.modeleCatalogue)).status).toBe(403)

    await avecMigrate((c) => c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [f.adminPlateformeP1, f.entrepriseB]))
    const admin = await session(f.adminPlateformeP1, f.entrepriseB)
    const r = await traiterCreationModele(req('POST', { portee: 'catalogue', intitule: 'Catalogue test', domaine: 'Sécurité', cibleType: 'site', items }, admin))
    expect(r.status).toBe(201)
    const { id } = await corps(r)
    expect((await corps(await traiterListeModeles(req('GET', undefined, await session(f.utilisateurA1))))).modeles.find((m: any) => m.id === id))
      .toMatchObject({ portee: 'catalogue' })
    expect((await traiterModificationModele(req('PUT', { intitule: 'Catalogue test 2', domaine: 'Sécurité', cibleType: 'site', items }, admin), id)).status).toBe(200)
    expect((await traiterSuppressionModele(req('DELETE', undefined, admin), id)).status).toBe(200)
  })
})

describe('Mon compte : changement de son mot de passe (migration 0019)', () => {
  it('mot de passe actuel exigé ; les autres sessions sont fermées, la session en cours reste ouverte', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const email = `mdp-${Date.now()}@client.test`
    const { id, motDePasse } = await corps(await traiterCreationCompte(req('POST', { nom: 'Kofi Client', email, role: 'declarant' }, consultant)))
    const ouvrir = async (mdp: string) => {
      const r = await traiterConnexion(req('POST', { email, motDePasse: mdp }))
      expect(r.status).toBe(200)
      return jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
    }
    const ici = await ouvrir(motDePasse)
    const ailleurs = await ouvrir(motDePasse)

    const changer = (actuel: string, nouveau: string) => traiterChangementMotDePasse(req('POST', { actuel, nouveau }, ici))
    expect((await changer('mauvais', 'Nouveau-mdp-2026')).status).toBe(400)
    expect((await changer(motDePasse, 'court')).status).toBe(400)
    expect((await traiterChangementMotDePasse(req('POST', { actuel: motDePasse, nouveau: 'Nouveau-mdp-2026' }, ici, null))).status).toBe(403)
    expect((await changer(motDePasse, 'Nouveau-mdp-2026')).status).toBe(200)

    expect((await traiterContexte(req('GET', undefined, ici))).status).toBe(200)
    expect((await traiterContexte(req('GET', undefined, ailleurs))).status).toBe(401)
    expect((await traiterConnexion(req('POST', { email, motDePasse }))).status).toBe(401)
    await ouvrir('Nouveau-mdp-2026')
    const trace = await avecMigrate(async (c) => (await c.query(
      "SELECT entreprise_id FROM journal_audit WHERE action = 'changement_mot_de_passe' AND objet_id = $1", [id])).rows)
    expect(trace).toEqual([{ entreprise_id: f.entrepriseB }])
  })
})

describe('Vue d’ensemble IFECARM (migration 0020)', () => {
  const ids = async (jeton: string) => (await corps(await traiterVueEnsemble(req('GET', undefined, jeton)))).entreprises.map((e: any) => e.entreprise_id)

  it('le consultant voit ses entreprises, l’administrateur toutes ; le client est refusé', async () => {
    const consultant = await session(f.consultantC1)
    const r = await corps(await traiterVueEnsemble(req('GET', undefined, consultant)))
    expect(r.administrateur).toBe(false)
    expect(r.entreprises.map((e: any) => e.entreprise_id)).toContain(f.entrepriseB)
    expect(r.entreprises.map((e: any) => e.entreprise_id)).not.toContain(f.entrepriseA)   // pas d'accès à A
    expect(r.entreprises.map((e: any) => e.entreprise_id)).not.toContain(f.ifecarmInterne)
    const b = r.entreprises.find((e: any) => e.entreprise_id === f.entrepriseB)
    expect(b).toMatchObject({ statut_relation: 'client' })
    expect(Object.keys(b).sort()).toEqual([
      'actions_en_retard', 'actions_ouvertes', 'comptes_actifs', 'derniere_note', 'derniere_note_le', 'entreprise_id', 'equipements_en_retard', 'formations_souhaitees', 'inspections_en_cours',
      'inspections_terminees_90j', 'nc_critique', 'nc_majeure', 'nc_mineure', 'nom', 'noms_comptes', 'notes_nb', 'services_souhaites', 'statut_relation', 'taux_conformite_90j'])

    const admin = await session(f.adminPlateformeP1)
    const ra = await corps(await traiterVueEnsemble(req('GET', undefined, admin)))
    expect(ra.administrateur).toBe(true)
    const tous = ra.entreprises.map((e: any) => e.entreprise_id)
    expect(tous).toEqual(expect.arrayContaining([f.entrepriseA, f.entrepriseB]))

    // Une entreprise désactivée sort de la vue, même pour l'administrateur.
    await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseA]))
    expect(await ids(admin)).not.toContain(f.entrepriseA)
    await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = NULL WHERE id = $1', [f.entrepriseA]))

    expect((await traiterVueEnsemble(req('GET', undefined, await session(f.utilisateurB1)))).status).toBe(403)
    expect((await traiterVueEnsemble(req('GET'))).status).toBe(401)
  })
})

describe('Administrateur : accès à tout ; pays d’intervention (migration 0021)', () => {
  it('l’administrateur entre dans n’importe quelle entreprise en écriture, sans mandat ; le consultant non', async () => {
    const admin = await session(f.adminPlateformeP1)
    const liste = (await corps(await traiterListeEntreprises(req('GET', undefined, admin)))).entreprises
    expect(liste.map((e: any) => e.id)).toEqual(expect.arrayContaining([f.entrepriseA, f.entrepriseB]))
    expect(liste.every((e: any) => e.supprimable && e.ecriture)).toBe(true)

    // Entreprise A : le consultant C1 n'a aucun mandat dessus, l'administrateur y entre et y crée un compte.
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: f.entrepriseA }, await session(f.consultantC1)))).status).toBe(403)
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: f.entrepriseA }, admin))).status).toBe(200)
    const r = await traiterCreationCompte(req('POST', { nom: 'Compte créé par admin', email: `admin-cree-${Date.now()}@client.test`, role: 'declarant' }, admin))
    expect(r.status).toBe(201)
    expect((await corps(await traiterContexte(req('GET', undefined, admin)))).peutConduire).toBe(true)

    // L'entreprise interne IFECARM GROUP reste hors de portée.
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: f.ifecarmInterne }, admin))).status).toBe(403)
  })

  it('pays : le consultant ajoute, seul l’administrateur renomme, archive et supprime', async () => {
    const consultant = await session(f.consultantC1)
    const admin = await session(f.adminPlateformeP1)
    const code = 'ZZ'
    await avecMigrate((c) => c.query('DELETE FROM pays_intervention WHERE code = $1', [code]))

    expect((await traiterCreationPays(req('POST', { code: 'z', nom: 'Zedland' }, consultant))).status).toBe(409) // code invalide
    expect((await traiterCreationPays(req('POST', { code, nom: 'Zedland' }, consultant))).status).toBe(201)
    expect((await traiterCreationPays(req('POST', { code, nom: 'Autre' }, consultant))).status).toBe(409)       // existe déjà
    expect((await traiterCreationPays(req('POST', { code: 'YY', nom: 'x' }, await session(f.utilisateurB1)))).status).toBe(403)

    const vue = await corps(await traiterListePays(req('GET', undefined, consultant)))
    expect(vue.administrateur).toBe(false)
    expect(vue.pays).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'BJ' }), expect.objectContaining({ code, nom: 'Zedland', actif: true })]))

    expect((await traiterModificationPays(req('PATCH', { nom: 'Zed', actif: false }, consultant), code)).status).toBe(403)
    expect((await traiterSuppressionPays(req('DELETE', undefined, consultant), code)).status).toBe(403)
    expect((await traiterModificationPays(req('PATCH', { nom: 'Zedonie', actif: false }, admin), code)).status).toBe(200)

    // Un pays archivé n'est plus proposé à la création d'un prospect.
    expect((await traiterCreationProspect(req('POST', { nom: 'Prospect Zed', pays: code }, consultant))).status).toBe(400)
    expect((await traiterSuppressionPays(req('DELETE', undefined, admin), code)).status).toBe(200)
    expect((await traiterSuppressionPays(req('DELETE', undefined, admin), code)).status).toBe(404)
    // Un pays utilisé par une entreprise ne se supprime pas.
    expect((await traiterSuppressionPays(req('DELETE', undefined, admin), 'BJ')).status).toBe(409)
  })
})

describe('Conversion d’un prospect en client (migration 0023)', () => {
  it('l’administrateur convertit un prospect en gardant son historique ; le consultant et le client ne le peuvent pas', async () => {
    const consultant = await session(f.consultantC1)
    const { id } = await corps(await traiterCreationProspect(req('POST', { nom: 'Prospect à convertir', pays: 'BJ' }, consultant)))
    prospects.push(id)
    await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, nouveauSite: { nom: 'Usine', ville: 'Cotonou' } }, consultant))

    const admin = await session(f.adminPlateformeP1)
    expect((await traiterConversionEntreprise(req('PATCH', {}, consultant), id)).status).toBe(403)
    expect((await traiterConversionEntreprise(req('PATCH', {}, await session(f.utilisateurB1)), id)).status).toBe(403)
    expect((await traiterConversionEntreprise(req('PATCH', {}, admin, null), id)).status).toBe(403)   // origine
    expect((await traiterConversionEntreprise(req('PATCH', {}, admin), id)).status).toBe(200)

    const ligne = (await corps(await traiterVueEnsemble(req('GET', undefined, admin)))).entreprises.find((e: any) => e.entreprise_id === id)
    expect(ligne).toMatchObject({ statut_relation: 'client', inspections_en_cours: 1 })
    expect((await traiterConversionEntreprise(req('PATCH', {}, admin), id)).status).toBe(409)           // déjà client
    expect((await traiterConversionEntreprise(req('PATCH', {}, admin), f.ifecarmInterne)).status).toBe(404)
    const trace = await avecMigrate(async (c) => (await c.query("SELECT details FROM journal_audit WHERE action = 'conversion_client' AND objet_id = $1", [id])).rows)
    expect(trace).toEqual([{ details: { nom: 'Prospect à convertir', de: 'prospect', vers: 'client' } }])
  })
})

describe('Administration : client, modules et accès des consultants', () => {
  it('l’administrateur crée un client, règle ses modules et les accès ; le consultant et le client sont refusés', async () => {
    const admin = await session(f.adminPlateformeP1)
    const consultant = await session(f.consultantC1)
    const nom = `Client créé ${Date.now()}`

    expect((await traiterCreationClient(req('POST', { nom, pays: 'BJ' }, consultant))).status).toBe(403)
    expect((await traiterLectureAdministration(req('GET', undefined, await session(f.utilisateurB1)))).status).toBe(403)
    expect((await traiterCreationClient(req('POST', { nom, pays: 'ZZ' }, admin))).status).toBe(400)            // pays inconnu
    expect((await traiterCreationClient(req('POST', { nom, pays: 'BJ', modules: ['inconnu'] }, admin))).status).toBe(400)
    const r = await traiterCreationClient(req('POST', { nom, pays: 'BJ', secteur: 'BTP', modules: ['inspections', 'formations'] }, admin))
    expect(r.status).toBe(201)
    const { id } = await corps(r)
    prospects.push(id)   // nettoyage : l'entreprise est désactivée en fin de test

    const lire = async () => (await corps(await traiterLectureAdministration(req('GET', undefined, admin)))).entreprises.find((e: any) => e.id === id)
    expect(await lire()).toMatchObject({ statut_relation: 'client', pays: 'BJ', acces: [] })
    expect((await lire()).modules).toEqual([{ module: 'formations', actif: true }, { module: 'inspections', actif: true }])

    const modifier = (c: unknown, jeton = admin) => traiterModificationEntreprise(req('PATCH', c, jeton), id)
    expect((await modifier({ action: 'module', module: 'formations', actif: false })).status).toBe(200)
    expect((await modifier({ action: 'module', module: 'incidents', actif: true })).status).toBe(200)
    expect((await lire()).modules).toEqual(expect.arrayContaining([{ module: 'formations', actif: false }, { module: 'incidents', actif: true }]))
    expect((await modifier({ action: 'module', module: 'inspections', actif: false }, consultant)).status).toBe(403)

    // Le consultant C1 n'a aucun accès : il en reçoit un (lecture seule, échéance), puis on le lui retire.
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: id }, consultant))).status).toBe(403)
    expect((await modifier({ action: 'acces', consultantId: f.consultantC1, ecriture: false, finLe: '2099-12-31' })).status).toBe(200)
    expect((await lire()).acces).toEqual([expect.objectContaining({ utilisateur_id: f.consultantC1, ecriture: false, fin_le: '2099-12-31' })])
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: id }, consultant))).status).toBe(200)
    expect((await traiterCreationCompte(req('POST', { nom: 'X', email: `x-${Date.now()}@t.test`, role: 'declarant' }, consultant))).status).toBe(403) // lecture seule
    expect((await modifier({ action: 'acces', consultantId: f.consultantC1, ecriture: true })).status).toBe(200)
    expect((await modifier({ action: 'acces', consultantId: f.utilisateurB1, ecriture: true })).status).toBe(400)   // pas un consultant
    expect((await modifier({ action: 'revoquer', consultantId: f.consultantC1 })).status).toBe(200)
    expect((await modifier({ action: 'revoquer', consultantId: f.consultantC1 })).status).toBe(404)
    expect((await modifier({ action: 'nimporte' })).status).toBe(400)

    // Un prospect n'a que les inspections et le tableau de bord.
    const prospect = (await corps(await traiterCreationProspect(req('POST', { nom: `Prospect admin ${Date.now()}`, pays: 'BJ' }, consultant)))).id
    prospects.push(prospect)
    expect((await traiterModificationEntreprise(req('PATCH', { action: 'module', module: 'formations', actif: true }, admin), prospect)).status).toBe(409)
  })
})

describe('Prospect : services et formations souhaités, sans délai d’accès (migrations 0024 à 0026)', () => {
  it('le consultant coche les services et choisit des formations du catalogue ; contrôles et affichage', async () => {
    const consultant = await session(f.consultantC1)
    const admin = await session(f.adminPlateformeP1)
    const creer = (corps: Record<string, unknown>) => traiterCreationProspect(req('POST', { nom: `Prospect souhaits ${Date.now()}`, pays: 'BJ', ...corps }, consultant))
    const { FICHES } = await import('@/formations/catalogue')
    const [a, b] = [FICHES[0]!.slug, FICHES[1]!.slug]

    expect((await creer({ services: ['danse'] })).status).toBe(400)
    expect((await creer({ services: ['formation'], formations: ['formation-inexistante'] })).status).toBe(400)

    const r = await creer({ services: ['formation', 'conseil'], formations: [a, b] })
    expect(r.status).toBe(201)
    const cree = await corps(r)
    prospects.push(cree.id)
    expect(cree.destination).toBe('/vue-ensemble')      // pas d'inspection demandée : retour à la liste
    const ligne = (await corps(await traiterVueEnsemble(req('GET', undefined, admin)))).entreprises.find((e: any) => e.entreprise_id === cree.id)
    expect(ligne.services_souhaites).toEqual(['conseil', 'formation'])
    expect([...ligne.formations_souhaitees].sort()).toEqual([a, b].sort())

    // Sans le service « Formation », les formations choisies sont ignorées ; avec « Inspection » on démarre l'inspection.
    const r2 = await creer({ services: ['inspection'], formations: [a] })
    const c2 = await corps(r2)
    prospects.push(c2.id)
    expect(c2.destination).toBe('/inspections/nouvelle')
    const l2 = (await corps(await traiterVueEnsemble(req('GET', undefined, admin)))).entreprises.find((e: any) => e.entreprise_id === c2.id)
    expect(l2.formations_souhaitees).toEqual([])

    // Sans délai : l'accès du consultant sur ce prospect n'a pas de date de fin.
    const acces = await avecMigrate(async (c) => (await c.query('SELECT fin_le FROM acces_consultant WHERE entreprise_id = $1', [cree.id])).rows)
    expect(acces).toEqual([{ fin_le: null }])
  })

  it('demande_formation : champs structurés validés, strictement internes (migration 0028)', async () => {
    const consultant = await session(f.consultantC1)
    const creer = (corps: Record<string, unknown>) => traiterCreationProspect(req('POST', { nom: `Prospect demandes ${Date.now()}`, pays: 'BJ', services: ['formation'], ...corps }, consultant))
    const { FICHES } = await import('@/formations/catalogue')
    const [a, b] = [FICHES[0]!.slug, FICHES[1]!.slug]

    expect((await creer({ formations: [{ slug: a, nb_participants: 0 }] })).status).toBe(400)
    expect((await creer({ formations: [{ slug: a, nb_participants: 'douze' }] })).status).toBe(400)
    expect((await creer({ formations: [{ slug: a, date_souhaitee: '31/01/2027' }] })).status).toBe(400)
    expect((await creer({ formations: [{ slug: a, note: 'x'.repeat(1001) }] })).status).toBe(400)
    expect((await creer({ formations: [{ slug: 'inconnue' }] })).status).toBe(400)

    const r = await creer({ formations: [{ slug: a, nb_participants: 12, date_souhaitee: '2027-01-15', note: ' sur site, 2×8 ' }, b] })
    expect(r.status).toBe(201)
    const id = (await corps(r)).id
    prospects.push(id)
    const lignes = await avecMigrate(async (c) => (await c.query(
      'SELECT formation_slug, nb_participants, to_char(date_souhaitee, \'YYYY-MM-DD\') AS date_souhaitee, note FROM demande_formation WHERE entreprise_id = $1', [id])).rows)
    expect(lignes.find((l: any) => l.formation_slug === a)).toEqual({ formation_slug: a, nb_participants: 12, date_souhaitee: '2027-01-15', note: 'sur site, 2×8' })
    expect(lignes.find((l: any) => l.formation_slug === b)).toEqual({ formation_slug: b, nb_participants: null, date_souhaitee: null, note: null })

    // Jamais visibles d'un utilisateur client, et pas d'écriture directe pour ifecarm_app.
    await avecMigrate((c) => c.query('INSERT INTO demande_formation (entreprise_id, formation_slug, note) VALUES ($1, $2, $3)', [f.entrepriseB, a, 'interne']))
    const vuParClient = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => trx.selectFrom('demande_formation').select('id').execute())
    expect(vuParClient).toEqual([])
    await expect(withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) =>
      sql`insert into demande_formation (entreprise_id, formation_slug) values (${f.entrepriseB}, ${b})`.execute(trx))).rejects.toThrow(/permission denied/)
    await avecMigrate((c) => c.query('DELETE FROM demande_formation WHERE entreprise_id = $1', [f.entrepriseB]))
  })

  it('modification après coup des souhaits et demandes : consultant en écriture seulement, client exclu (migration 0028)', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const lecture = await session(fi.consultantLecture, f.entrepriseA)
    const client = await session(f.utilisateurB1)
    const { FICHES } = await import('@/formations/catalogue')
    const [a, b] = [FICHES[0]!.slug, FICHES[1]!.slug]
    const put = (corpsReq: Record<string, unknown>, s = consultant) => traiterModificationSouhaits(req('PUT', corpsReq, s))

    expect((await put({ services: ['danse'] })).status).toBe(400)
    expect((await put({ services: ['formation'], formations: [{ slug: a, nb_participants: -3 }] })).status).toBe(400)
    expect((await put({ services: ['formation', 'audit'], formations: [{ slug: a, nb_participants: 8, date_souhaitee: '2027-03-01', note: 'sur site' }, { slug: b }] })).status).toBe(200)
    let lu = await corps(await traiterLectureSouhaits(req('GET', undefined, consultant)))
    expect([...lu.services].sort()).toEqual(['audit', 'formation'])
    expect(lu.demandes.find((d: any) => d.slug === a)).toMatchObject({ slug: a, nb_participants: 8, date_souhaitee: '2027-03-01', note: 'sur site' })
    expect(lu.demandes).toHaveLength(2)

    // Remplacement : sans le service « Formation », les demandes disparaissent.
    expect((await put({ services: ['audit'], formations: [{ slug: a }] })).status).toBe(200)
    lu = await corps(await traiterLectureSouhaits(req('GET', undefined, consultant)))
    expect(lu.demandes).toEqual([])

    // Lecture seule : lit sans écrire. Client : ni l'un ni l'autre.
    expect((await traiterLectureSouhaits(req('GET', undefined, lecture))).status).toBe(200)
    expect((await put({ services: ['audit'] }, lecture)).status).toBe(403)
    expect((await traiterLectureSouhaits(req('GET', undefined, client))).status).toBe(403)
    expect((await put({ services: ['audit'] }, client)).status).toBe(403)

    await avecMigrate((c) => c.query("UPDATE entreprise SET services_souhaites = '{}' WHERE id = $1", [f.entrepriseB]))
  })
})

describe('Suivi interne : notes du consultant et de l’administrateur, jamais visibles du client (migration 0027)', () => {
  it('le consultant note, l’administrateur voit et supprime, le client ne voit ni ne peut rien', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const admin = await session(f.adminPlateformeP1, f.entrepriseB)
    const client = await session(f.utilisateurB1)

    expect((await traiterAjoutNote(req('POST', { contenu: '   ' }, consultant))).status).toBe(400)
    const r = await traiterAjoutNote(req('POST', { contenu: 'Relancé, intéressé par la formation SST.' }, consultant))
    expect(r.status).toBe(201)
    const { id } = await corps(r)

    const vueConsultant = (await corps(await traiterListeNotes(req('GET', undefined, consultant)))).notes
    expect(vueConsultant).toEqual([expect.objectContaining({ id, contenu: 'Relancé, intéressé par la formation SST.' })])
    expect(vueConsultant[0].auteur_nom).toBeTruthy()
    expect((await corps(await traiterListeNotes(req('GET', undefined, admin)))).notes).toHaveLength(1)

    // Le client : refusé par l'API, et vide même en interrogeant la base sous son identité.
    expect((await traiterListeNotes(req('GET', undefined, client))).status).toBe(403)
    expect((await traiterAjoutNote(req('POST', { contenu: 'x' }, client))).status).toBe(403)
    expect((await traiterSuppressionNote(req('DELETE', undefined, client), id)).status).toBe(403)
    const vuParClient = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => trx.selectFrom('note_suivi').select('id').execute())
    expect(vuParClient).toEqual([])

    // Lecture seule : le consultant lit mais n'écrit pas. Une autre entreprise n'y voit rien.
    const lecture = await session(fi.consultantLecture, f.entrepriseA)
    expect((await corps(await traiterListeNotes(req('GET', undefined, lecture)))).notes).toEqual([])
    expect((await traiterAjoutNote(req('POST', { contenu: 'x' }, lecture))).status).toBe(403)

    // La ligne de la vue d'ensemble affiche la dernière note ; suppression par l'auteur, journalisée.
    const ligne = (await corps(await traiterVueEnsemble(req('GET', undefined, admin)))).entreprises.find((e: any) => e.entreprise_id === f.entrepriseB)
    expect(ligne).toMatchObject({ notes_nb: 1, derniere_note: 'Relancé, intéressé par la formation SST.' })
    expect((await traiterSuppressionNote(req('DELETE', undefined, consultant), id)).status).toBe(200)
    expect((await corps(await traiterListeNotes(req('GET', undefined, admin)))).notes).toEqual([])
  })
})

describe('Administration : création d’un compte consultant (opération creer_compte_consultant)', () => {
  it('réservée à l’administrateur ; mot de passe provisoire une fois ; aucun accès tant qu’il n’est pas accordé', async () => {
    const admin = await session(f.adminPlateformeP1)
    const consultant = await session(f.consultantC1)
    const email = `nouveau.consultant.${Date.now()}@ifecarm.test`
    const creer = (c: Record<string, unknown>, jeton = admin) => traiterCreationConsultant(req('POST', c, jeton))

    expect((await creer({ nom: 'Test Consultant', email }, consultant)).status).toBe(403)
    expect((await traiterCreationConsultant(req('POST', { nom: 'X', email }, admin, null))).status).toBe(403)  // origine absente
    expect((await creer({ nom: '', email })).status).toBe(400)
    expect((await creer({ nom: 'Test Consultant', email: 'pas-un-email' })).status).toBe(400)

    const r = await creer({ nom: 'Test Consultant', email })
    expect(r.status).toBe(201)
    const { id, motDePasse } = await corps(r)
    try {
      expect(motDePasse).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/)
      expect((await creer({ nom: 'Doublon', email })).status).toBe(409)

      // Rôle, entreprise interne, hash seul en base, aucun accès accordé.
      const ligne = await avecMigrate(async (c) => (await c.query(
        `SELECT e.interne, u.mot_de_passe_hash, array_agg(r.role) AS roles,
                (SELECT count(*) FROM acces_consultant a WHERE a.utilisateur_id = u.id)::int AS acces
         FROM utilisateur u JOIN entreprise e ON e.id = u.entreprise_id JOIN role_utilisateur r ON r.utilisateur_id = u.id
         WHERE u.id = $1 GROUP BY e.interne, u.id`, [id])).rows[0])
      expect(ligne.interne).toBe(true)
      expect(ligne.roles).toEqual(['consultant_ifecarm'])
      expect(ligne.acces).toBe(0)

      // Il figure dans la liste de l'administration, sans accès ; accordé, l'accès apparaît ; le consultant ne voit pas cette liste.
      const dansListe = async () => (await corps(await traiterLectureAdministration(req('GET', undefined, admin)))).consultants.find((c: any) => c.id === id)
      expect(await dansListe()).toMatchObject({ nom: 'Test Consultant', email, acces: [] })
      expect((await dansListe()).cree_le).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
      await avecMigrate((c) => c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le) VALUES ($1, $2, false, $3)', [id, f.entrepriseA, '2099-12-31']))
      expect((await dansListe()).acces).toEqual([{ entreprise_id: f.entrepriseA, nom: expect.any(String), ecriture: false, fin_le: '2099-12-31' }])
      expect((await traiterLectureAdministration(req('GET', undefined, consultant))).status).toBe(403)
      await avecMigrate((c) => c.query('DELETE FROM acces_consultant WHERE utilisateur_id = $1', [id]))   // retour à « aucun accès » pour la suite du test
      expect(ligne.mot_de_passe_hash).toMatch(/^\$argon2id\$/)
      expect(ligne.mot_de_passe_hash).not.toContain(motDePasse)

      // Il peut se connecter avec le mot de passe provisoire, mais ne voit aucune entreprise.
      const connexion = await traiterConnexion(req('POST', { email, motDePasse }))
      expect(connexion.status).toBe(200)
      const cookie = connexion.headers.get('set-cookie')!.split(';')[0]!
      const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie } }))!
      await libererA2f(jeton)
      expect((await corps(await traiterListeEntreprises(req('GET', undefined, jeton)))).entreprises ?? []).toEqual([])
      expect((await traiterLectureAdministration(req('GET', undefined, jeton))).status).toBe(403)
    } finally {
      await avecMigrate((c) => c.query('DELETE FROM utilisateur WHERE id = $1', [id]))
    }
  })

  it('suppression définitive d’un consultant : administrateur seul, email ressaisi, historique conservé, déconnexion immédiate', async () => {
    const admin = await session(f.adminPlateformeP1)
    const autre = await session(f.consultantC1)
    const email = `a.supprimer.${Date.now()}@ifecarm.test`
    const { id, motDePasse } = await corps(await traiterCreationConsultant(req('POST', { nom: 'À Supprimer', email }, admin)))
    const suppr = (cible: string, c: Record<string, unknown>, jeton = admin) => traiterSuppressionConsultant(req('DELETE', c, jeton), cible)

    // Il travaille : accès en écriture à B, une inspection à son nom, une session ouverte.
    await avecMigrate((c) => c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [id, f.entrepriseB]))
    const connexion = await traiterConnexion(req('POST', { email, motDePasse }))
    const cookie = connexion.headers.get('set-cookie')!.split(';')[0]!
    const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie } }))!
    await libererA2f(jeton)
    expect((await traiterChoixEntreprise(req('POST', { entrepriseId: f.entrepriseB }, jeton))).status).toBe(200)
    const inspectionId = (await corps(await traiterCreation(req('POST', { modeleId: fi.modeleCatalogue, siteId: fi.siteB, inspecteurNom: 'Ing. À Supprimer' }, jeton)))).id

    // Refus : pas administrateur, email absent ou faux, cible inconnue, cible administrateur.
    expect((await suppr(id, { confirmation: email }, autre)).status).toBe(403)
    expect((await suppr(id, {})).status).toBe(409)
    expect((await suppr(id, { confirmation: 'autre@ifecarm.test' })).status).toBe(409)
    expect((await suppr('00000000-0000-0000-0000-000000000000', { confirmation: email })).status).toBe(404)
    expect((await suppr(f.adminPlateformeP1, { confirmation: emails.get(f.adminPlateformeP1) })).status).toBe(404)   // un administrateur ne se supprime pas ici
    expect((await traiterSuppressionConsultant(req('DELETE', { confirmation: email }, admin, null), id)).status).toBe(403)   // origine absente

    // Succès (email insensible à la casse) : compte, accès et session disparaissent ; l'inspection reste.
    expect((await suppr(id, { confirmation: ` ${email.toUpperCase()} ` })).status).toBe(200)
    const reste = await avecMigrate(async (c) => ({
      compte: (await c.query('SELECT 1 FROM utilisateur WHERE id = $1', [id])).rowCount,
      acces: (await c.query('SELECT 1 FROM acces_consultant WHERE utilisateur_id = $1', [id])).rowCount,
      inspection: (await c.query('SELECT consultant_id, inspecteur_nom FROM inspection WHERE id = $1', [inspectionId])).rows[0],
      journal: (await c.query("SELECT details FROM journal_audit WHERE action = 'suppression' AND objet_type = 'utilisateur' AND objet_id = $1", [id])).rows,
    }))
    expect(reste.compte).toBe(0)
    expect(reste.acces).toBe(0)
    expect(reste.inspection).toEqual({ consultant_id: null, inspecteur_nom: 'Ing. À Supprimer' })
    expect(reste.journal).toHaveLength(1)
    expect((await traiterListeEntreprises(req('GET', undefined, jeton))).status).toBe(401)           // déconnecté sur-le-champ
    expect((await traiterConnexion(req('POST', { email, motDePasse }))).status).toBe(401)
    expect((await suppr(id, { confirmation: email })).status).toBe(404)                                 // déjà supprimé
  })

  it('réinitialisation du mot de passe d’un consultant : administrateur seul, nouveau mot de passe affiché une fois, ancien invalide, sessions révoquées', async () => {
    const admin = await session(f.adminPlateformeP1)
    const autre = await session(f.consultantC1)
    const email = `reinit.${Date.now()}@ifecarm.test`
    const { id, motDePasse: ancien } = await corps(await traiterCreationConsultant(req('POST', { nom: 'Réinit', email }, admin)))
    try {
      const connexion = await traiterConnexion(req('POST', { email, motDePasse: ancien }))
      const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: connexion.headers.get('set-cookie')!.split(';')[0]! } }))!
      const reinit = (cible: string, c: Record<string, unknown>, j = admin, origine: string | null = ORIGINE) => traiterModificationConsultant(req('PATCH', c, j, origine), cible)

      expect((await reinit(id, { action: 'mot_de_passe' }, autre)).status).toBe(403)
      expect((await reinit(id, { action: 'mot_de_passe' }, admin, null)).status).toBe(403)
      expect((await reinit(id, { action: 'autre' })).status).toBe(400)
      expect((await reinit(f.adminPlateformeP1, { action: 'mot_de_passe' })).status).toBe(404)         // jamais celui d'un administrateur
      expect((await reinit('00000000-0000-0000-0000-000000000000', { action: 'mot_de_passe' })).status).toBe(404)

      const r = await reinit(id, { action: 'mot_de_passe' })
      expect(r.status).toBe(200)
      const { motDePasse } = await corps(r)
      expect(motDePasse).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/)
      expect(motDePasse).not.toBe(ancien)
      expect((await traiterListeEntreprises(req('GET', undefined, jeton))).status).toBe(401)           // session précédente révoquée
      expect((await traiterConnexion(req('POST', { email, motDePasse: ancien }))).status).toBe(401)
      expect((await traiterConnexion(req('POST', { email, motDePasse }))).status).toBe(200)
      const hash = await avecMigrate(async (c) => (await c.query('SELECT mot_de_passe_hash FROM utilisateur WHERE id = $1', [id])).rows[0].mot_de_passe_hash as string)
      expect(hash).toMatch(/^\$argon2id\$/)
      expect(hash).not.toContain(motDePasse)
    } finally {
      await avecMigrate((c) => c.query('DELETE FROM utilisateur WHERE id = $1', [id]))
    }
  })
})
