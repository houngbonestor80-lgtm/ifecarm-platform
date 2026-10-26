import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import {
  traiterAjoutParticipant, traiterCatalogue, traiterCatalogueAdmin, traiterCreationSession, traiterDemandes, traiterDetailSession,
  traiterListeSessions, traiterModificationCatalogue, traiterModificationParticipant, traiterModificationSession,
  traiterRetraitParticipant, traiterSalaries,
} from '@/formations/routes'
import { traiterModificationSouhaits } from '@/suivi/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

/**
 * Routes B2 de bout en bout (vraie session → avecTenant → module → RLS) :
 * module formations requis, écriture réservée à l'équipe IFECARM, lecture
 * client, lien demande ↔ session, catalogue administrateur.
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
let fi: FixturesInspections
let ff: FixturesFormations
let slugCatalogue = ''
let formationCat = ''
const emails = new Map<string, string>()

async function avecMigrate<T>(cb: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  try { return await cb(client) } finally { await client.end() }
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
  ff = await creerFixturesFormations(f)
  await avecMigrate(async (c) => {
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [
      [f.utilisateurA1, f.utilisateurB1, f.consultantC1, f.adminPlateformeP1, fi.consultantLecture],
    ])
    rows.forEach((r) => emails.set(r.id, r.email))
    const { FICHES } = await import('@/formations/catalogue')
    slugCatalogue = FICHES[0]!.slug
    formationCat = (await c.query(
      "INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours) VALUES (NULL, $1, 'Catalogue test', 'test', 1) ON CONFLICT (slug) WHERE entreprise_id IS NULL DO UPDATE SET slug = excluded.slug RETURNING id", [slugCatalogue])).rows[0].id
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
  try { await nettoyerFixturesInspections(fi) } catch { /* idem */ }
})

describe('Module formations requis', () => {
  it('sans module actif : 403 pour tout le monde, consultant compris', async () => {
    const consultant = await session(f.consultantC1, f.entrepriseB)
    expect((await traiterListeSessions(req('GET', undefined, consultant))).status).toBe(403)
    expect((await traiterCreationSession(req('POST', {}, consultant))).status).toBe(403)
  })
})

describe('Sessions, participants et lien avec les demandes (entreprise B)', () => {
  let consultant: string
  let client: string
  let demandeId: string
  let sessionId: string
  let participantId: string

  beforeAll(async () => {
    await avecMigrate(async (c) => {
      await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'formations'), ($2, 'formations')", [f.entrepriseA, f.entrepriseB])
      demandeId = (await c.query(
        "INSERT INTO demande_formation (entreprise_id, formation_slug, nb_participants, date_souhaitee, note) VALUES ($1, $2, 8, '2027-03-01', 'sur site') RETURNING id",
        [f.entrepriseB, slugCatalogue])).rows[0].id
    })
    consultant = await session(f.consultantC1, f.entrepriseB)
    client = await session(f.utilisateurB1)
  })

  const session_ = (c: Record<string, unknown>, jeton = consultant) => traiterCreationSession(req('POST', {
    formationId: formationCat, dateDebut: '2027-03-01', dateFin: '2027-03-02', heureDebut: '08:00', heureFin: '16:00', dureeHeures: 14, lieu: 'Cotonou', ...c }, jeton))

  it('catalogue et demandes à planifier visibles du consultant ; la demande est prête à lier', async () => {
    expect((await corps(await traiterCatalogue(req('GET', undefined, consultant)))).formations.map((x: any) => x.id)).toContain(formationCat)
    const d = (await corps(await traiterDemandes(req('GET', undefined, consultant)))).demandes
    expect(d).toEqual([expect.objectContaining({ id: demandeId, nb_participants: 8, date_souhaitee: '2027-03-01', session_id: null, formation_id: formationCat })])
  })

  it('création : durée obligatoire, dates et horaires cohérents, demande de la bonne formation', async () => {
    expect((await session_({ dureeHeures: undefined })).status).toBe(400)
    expect((await session_({ dureeHeures: 0 })).status).toBe(400)
    expect((await session_({ dateFin: '2027-02-28' })).status).toBe(400)
    expect((await session_({ heureDebut: '16:00', heureFin: '08:00' })).status).toBe(400)
    expect((await session_({ formationId: ff.formationA })).status).toBe(404)            // formation d'une autre entreprise : invisible
    expect((await session_({ demandeId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404)
    // Demande portant sur une autre formation du catalogue : refusée.
    const autre = await avecMigrate(async (c) => (await c.query(
      "INSERT INTO demande_formation (entreprise_id, formation_slug) VALUES ($1, $2) RETURNING id", [f.entrepriseB, `autre-${Date.now()}`])).rows[0].id)
    expect((await session_({ demandeId: autre })).status).toBe(409)
    await avecMigrate((c) => c.query('DELETE FROM demande_formation WHERE id = $1', [autre]))
  })

  it('une session créée depuis une demande la lie (planifiée) ; une demande ne sert qu’une fois', async () => {
    const r = await session_({ demandeId, placesMax: 1 })
    expect(r.status).toBe(201)
    const cree = await corps(r)
    sessionId = cree.id
    expect(cree.reference).toMatch(/^S-2027-\d{3}$/)

    const d = (await corps(await traiterDemandes(req('GET', undefined, consultant)))).demandes.find((x: any) => x.id === demandeId)
    expect(d).toMatchObject({ session_id: sessionId, reference: cree.reference })
    expect((await session_({ demandeId })).status).toBe(409)

    const suivante = await corps(await session_({}))
    expect(Number(suivante.reference.slice(-3))).toBe(Number(cree.reference.slice(-3)) + 1)

    const detail = (await corps(await traiterDetailSession(req('GET', undefined, consultant), sessionId))).session
    expect(detail).toMatchObject({ duree_heures: 14, heure_debut: '08:00', heure_fin: '16:00', demande: { id: demandeId, nb_participants: 8 } })
  })

  it('les souhaits du prospect peuvent être modifiés sans casser le lien ; une demande planifiée ne se retire pas', async () => {
    const put = (c: Record<string, unknown>) => traiterModificationSouhaits(req('PUT', c, consultant))
    expect((await put({ services: ['formation'], formations: [{ slug: slugCatalogue, nb_participants: 10, note: 'mise à jour' }] })).status).toBe(200)
    const d = (await corps(await traiterDemandes(req('GET', undefined, consultant)))).demandes.find((x: any) => x.id === demandeId)
    expect(d).toMatchObject({ session_id: sessionId, nb_participants: 10, note: 'mise à jour' })
    expect((await put({ services: ['formation'], formations: [] })).status).toBe(409)
  })

  it('participants : inscription (nouveau salarié ou existant), doublon, session complète, résultat, retrait', async () => {
    const ajout = (c: Record<string, unknown>) => traiterAjoutParticipant(req('POST', c, consultant), sessionId)
    expect((await ajout({ nouveauSalarie: { nom: 'Dossou' } })).status).toBe(400)
    const r = await ajout({ nouveauSalarie: { nom: 'Dossou', prenom: 'Afi', poste: 'Soudeuse' } })
    expect(r.status).toBe(201)
    participantId = (await corps(r)).id
    expect((await ajout({ salarieId: f.salarieB1 })).status).toBe(409)                    // places_max = 1 : complète
    expect((await ajout({ salarieId: f.salarieA1 })).status).toBe(409)                    // complète d'abord ; l'autre entreprise est testée plus bas

    expect((await traiterModificationParticipant(req('PATCH', { statut: 'present', resultat: 'apte' }, consultant), participantId)).status).toBe(200)
    expect((await traiterModificationParticipant(req('PATCH', { resultat: 'excellent' }, consultant), participantId)).status).toBe(400)
    const p = (await corps(await traiterDetailSession(req('GET', undefined, consultant), sessionId))).session.participants
    expect(p).toEqual([expect.objectContaining({ id: participantId, nom: 'Dossou', statut: 'present', resultat: 'apte' })])

    expect((await traiterModificationSession(req('PATCH', { placesMax: 5 }, consultant), sessionId)).status).toBe(200)
    expect((await ajout({ salarieId: f.salarieA1 })).status).toBe(404)                    // salarié d'une autre entreprise : invisible
    expect((await ajout({ salarieId: f.salarieB1 })).status).toBe(201)
    expect((await traiterRetraitParticipant(req('DELETE', undefined, consultant), participantId)).status).toBe(200)

    expect((await traiterModificationSession(req('PATCH', { statut: 'annulee' }, consultant), sessionId)).status).toBe(200)
    expect((await ajout({ nouveauSalarie: { nom: 'X', prenom: 'Y' } })).status).toBe(409)  // annulée
    expect((await traiterModificationSession(req('PATCH', { statut: 'inconnu' }, consultant), sessionId)).status).toBe(400)
  })

  it('inscription en lot : salariés existants et nouveaux d’un coup, tout ou rien, places contrôlées sur le lot', async () => {
    const sid = (await corps(await session_({ placesMax: 3 }))).id
    const lot = (c: Record<string, unknown>) => traiterAjoutParticipant(req('POST', c, consultant), sid)

    expect((await lot({})).status).toBe(400)                                                         // rien à inscrire
    expect((await lot({ nouveauxSalaries: [{ prenom: 'Sans', nom: '' }] })).status).toBe(400)         // ligne incomplète
    expect((await lot({ nouveauxSalaries: [{ prenom: 'A', nom: 'A' }, { prenom: 'B', nom: 'B' }, { prenom: 'C', nom: 'C' }, { prenom: 'D', nom: 'D' }] })).status).toBe(409)  // 4 > 3 places
    expect((await lot({ salarieIds: [f.salarieB1, f.salarieA1] })).status).toBe(404)                 // un salarié d'une autre entreprise : rien n'est inscrit
    expect((await corps(await traiterDetailSession(req('GET', undefined, consultant), sid))).session.participants).toEqual([])

    const r = await lot({ salarieIds: [f.salarieB1], nouveauxSalaries: [{ prenom: 'Afi', nom: 'Dossou', poste: 'Soudeuse' }, { prenom: 'Koffi', nom: 'Agbodjan' }] })
    expect(r.status).toBe(201)
    const cree = await corps(r)
    expect(cree.ajoutes).toBe(3)
    expect(cree.ids).toHaveLength(3)
    expect((await corps(await traiterDetailSession(req('GET', undefined, consultant), sid))).session.participants).toHaveLength(3)

    // Session complète ; et un doublon dans un lot annule tout le lot.
    expect((await lot({ nouveauxSalaries: [{ prenom: 'E', nom: 'E' }] })).status).toBe(409)
    const sid2 = (await corps(await session_({}))).id
    const doublon = await traiterAjoutParticipant(req('POST', { salarieIds: [f.salarieB1], nouveauxSalaries: [{ prenom: 'Zoé', nom: 'Test' }] }, consultant), sid2)
    expect(doublon.status).toBe(201)
    const second = await traiterAjoutParticipant(req('POST', { salarieIds: [f.salarieB1], nouveauxSalaries: [{ prenom: 'Yann', nom: 'Test' }] }, consultant), sid2)
    expect(second.status).toBe(409)
    expect((await corps(await traiterDetailSession(req('GET', undefined, consultant), sid2))).session.participants).toHaveLength(2)   // Yann n'a pas été créé comme participant

    // Le client ne peut pas inscrire en lot.
    expect((await traiterAjoutParticipant(req('POST', { salarieIds: [f.salarieB1] }, client), sid2)).status).toBe(403)
  })

  it('un participant avec attestation ne peut pas être retiré', async () => {
    const p = (await corps(await traiterAjoutParticipant(req('POST', { salarieId: f.salarieB1 }, consultant), (await corps(await session_({}))).id))).id
    await avecMigrate((c) => c.query(
      `INSERT INTO attestation (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie, intitule_formation, nom_entreprise, date_debut, date_fin)
       VALUES ($1, $2, $3, 'N', 'P', 'F', 'E', '2027-03-01', '2027-03-02')`, [f.entrepriseB, p, `ATT-${Date.now()}`]))
    expect((await traiterRetraitParticipant(req('DELETE', undefined, consultant), p)).status).toBe(409)
  })

  it('le client lit ses sessions (sans voir la demande interne) mais ne peut rien écrire ni lister l’interne', async () => {
    const liste = (await corps(await traiterListeSessions(req('GET', undefined, client)))).sessions
    expect(liste.map((s: any) => s.id)).toContain(sessionId)
    const detail = (await corps(await traiterDetailSession(req('GET', undefined, client), sessionId))).session
    expect(detail.demande).toBeNull()

    expect((await session_({}, client)).status).toBe(403)
    expect((await traiterModificationSession(req('PATCH', { lieu: 'x' }, client), sessionId)).status).toBe(403)
    expect((await traiterAjoutParticipant(req('POST', { salarieId: f.salarieB1 }, client), sessionId)).status).toBe(403)
    expect((await traiterModificationParticipant(req('PATCH', { statut: 'absent' }, client), participantId)).status).toBe(403)
    expect((await traiterDemandes(req('GET', undefined, client))).status).toBe(403)
    expect((await traiterSalaries(req('GET', undefined, client))).status).toBe(403)
    expect((await traiterCreationSession(req('POST', {}, consultant, null))).status).toBe(403)   // origine absente
  })

  it('cloisonnement : consultant en lecture seule sur A lit sans écrire, et ne voit rien de B', async () => {
    const lecture = await session(fi.consultantLecture, f.entrepriseA)
    const liste = (await corps(await traiterListeSessions(req('GET', undefined, lecture)))).sessions
    expect(liste.map((s: any) => s.id)).toEqual([ff.sessionA])
    expect((await traiterDetailSession(req('GET', undefined, lecture), sessionId)).status).toBe(404)
    expect((await traiterCreationSession(req('POST', { formationId: ff.formationA, dateDebut: '2027-01-01', dateFin: '2027-01-01', dureeHeures: 7 }, lecture))).status).toBe(403)
  })
})

describe('Catalogue : validité des certifications (administrateur)', () => {
  it('l’administrateur renseigne validite_mois ; le consultant et le client n’ont pas la main', async () => {
    const admin = await session(f.adminPlateformeP1)
    const consultant = await session(f.consultantC1, f.entrepriseB)
    const patch = (c: Record<string, unknown>, jeton = admin) => traiterModificationCatalogue(req('PATCH', c, jeton), ff.formationCatalogue)

    const liste = (await corps(await traiterCatalogueAdmin(req('GET', undefined, admin)))).formations
    expect(liste.find((x: any) => x.id === ff.formationCatalogue)).toMatchObject({ validite_mois: 24, actif: true })

    expect((await patch({ validiteMois: 36 })).status).toBe(200)
    expect((await patch({ validiteMois: 0 })).status).toBe(400)
    expect((await patch({ validiteMois: 'x' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    expect((await patch({ validiteMois: null })).status).toBe(200)       // sans échéance
    const apres = (await corps(await traiterCatalogueAdmin(req('GET', undefined, admin)))).formations.find((x: any) => x.id === ff.formationCatalogue)
    expect(apres.validite_mois).toBeNull()

    expect((await patch({ validiteMois: 12 }, consultant)).status).toBe(403)
    expect((await traiterCatalogueAdmin(req('GET', undefined, consultant))).status).toBe(403)
    expect((await traiterCatalogueAdmin(req('GET', undefined, await session(f.utilisateurB1)))).status).toBe(403)
  })
})
