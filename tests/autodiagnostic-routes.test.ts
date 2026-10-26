import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  traiterActionsAutodiagnostic, traiterCatalogueAutodiagnostic, traiterCreationAutodiagnostic, traiterCreationReferentiel, traiterDetailAutodiagnostic,
  traiterListeAutodiagnostics, traiterModificationReferentiel, traiterRapportAutodiagnostic, traiterReponsesAutodiagnostic, traiterResumeAutodiagnostic,
  traiterSuppressionAutodiagnostic, traiterSuppressionReferentiel, traiterTerminerAutodiagnostic,
} from '@/autodiagnostic/routes'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterChoixEntreprise, traiterConnexion } from '@/auth/routes'
import { hacherMotDePasse } from '@/auth/password'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * B1 — couche routes : droits par rôle, flux complet (création → réponses → fin → actions → rapport PDF), catalogue géré par
 * l'admin, module requis. Le cloisonnement SQL et le calcul du score sont couverts par tests/autodiagnostic.test.ts.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const MDP = 'mot-de-passe-de-test-jamais-utilise'
const suffixe = randomUUID().slice(0, 6)
const CODE = `t${suffixe}-routes`

const PETIT = {
  echelleReponses: [
    { code: 'oui', libelle: 'Oui', coefficient: 1 },
    { code: 'partiel', libelle: 'Partiellement', coefficient: 0.5 },
    { code: 'non', libelle: 'Non', coefficient: 0 },
  ],
  niveaux: [
    { seuilMin: 0, seuilMax: 49, libelle: 'Bas', message: 'À construire.' },
    { seuilMin: 50, seuilMax: 100, libelle: 'Haut', message: 'Solide.' },
  ],
  themes: [
    { code: 'a', libelle: 'Thème A', questions: [
      { id: 'a-1', texte: 'Question A1', poids: 3, recommandation: 'Faire A1' },
      { id: 'a-2', texte: 'Question A2', poids: 1, recommandation: 'Faire A2' },
    ] },
    { code: 'b', libelle: 'Thème B', questions: [{ id: 'b-1', texte: 'Question B1', poids: 2, recommandation: 'Faire B1' }] },
  ],
}

let f: Fixtures
const emails = new Map<string, string>()
let consultant: string
let admin: string
let adminEntreprise: string
let qhse: string
let declarant: string
let chezB: string

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
async function compte(role: string): Promise<string> {
  const email = `ad-${role}-${randomUUID().slice(0, 8)}@test.local`
  const hash = await hacherMotDePasse(MDP)
  const id = await migrate(async (c) => {
    const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.entrepriseA, email, role, hash])
    await c.query('INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, $2)', [u.id, role])
    return u.id as string
  })
  emails.set(id, email)
  return id
}

const json = async (r: Response) => (await r.clone().json()) as Record<string, any>
const creer = async (extra: Record<string, unknown> = {}, jeton = consultant) => traiterCreationAutodiagnostic(req('POST', jeton, { referentiel: CODE, interlocuteur: 'M. Responsable', ...extra }))
const evaluation = async (id: string, jeton = consultant) => (await json(await traiterDetailAutodiagnostic(req('GET', jeton), id))).evaluation
const repondre = (id: string, corps: unknown, jeton = consultant) => traiterReponsesAutodiagnostic(req('PATCH', jeton, corps), id)
const terminee = async (reponses: Record<string, string> = { 'a-1': 'oui', 'a-2': 'non', 'b-1': 'partiel' }) => {
  const r = await creer({ nouveauSite: { nom: `Site libre ${randomUUID().slice(0, 5)}`, ville: 'Cotonou' } })
  expect(r.status, await r.clone().text()).toBe(201)
  const { id } = await json(r)
  expect((await repondre(id, { reponses })).status).toBe(200)
  const fin = await traiterTerminerAutodiagnostic(req('POST', consultant, {}), id)
  expect(fin.status, await fin.clone().text()).toBe(200)
  return id as string
}

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.consultantC1, f.adminPlateformeP1, f.utilisateurA1, f.utilisateurB1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'autodiagnostic')", [f.entrepriseA])
    await c.query('INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)', [f.consultantC1, f.entrepriseA])
  })
  qhse = await compte('responsable_qhse')
  declarant = await compte('declarant')
  admin = await session(f.adminPlateformeP1)
  const r = await traiterCreationReferentiel(req('POST', admin, { code: CODE, titre: `Référentiel ${CODE}`, description: 'Test', dureeEstimeeMinutes: 5, avertissement: 'Indicatif.', definition: PETIT }))
  expect(r.status, await r.clone().text()).toBe(201)
  consultant = await session(f.consultantC1, f.entrepriseA)
  adminEntreprise = await session(f.utilisateurA1)
  chezB = await session(f.utilisateurB1)
  const qhseJeton = await session(qhse)
  const declarantJeton = await session(declarant)
  Object.assign(globalThis, { __qhse: qhseJeton, __declarant: declarantJeton })
})

afterAll(async () => {
  try {
    await migrate(async (c) => {
      await c.query('DELETE FROM autodiagnostic_action WHERE entreprise_id = $1', [f.entrepriseA])
      await c.query('DELETE FROM action_corrective WHERE entreprise_id = $1', [f.entrepriseA])
      await c.query('DELETE FROM utilisateur WHERE id = ANY($1)', [[qhse, declarant]])
    })
  } catch { /* nettoyage au mieux */ }
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

const jetonQhse = () => (globalThis as unknown as { __qhse: string }).__qhse
const jetonDeclarant = () => (globalThis as unknown as { __declarant: string }).__declarant

describe('Catalogue des référentiels (administrateur)', () => {
  it('création refusée au consultant ; questionnaire invalide expliqué ; code déjà pris refusé', async () => {
    expect((await traiterCreationReferentiel(req('POST', consultant, { code: 'x-interdit' }))).status).toBe(403)
    const base = { titre: 'T', description: 'D', dureeEstimeeMinutes: 5, avertissement: 'A' }
    const sansReponsePleine = { ...PETIT, echelleReponses: [{ code: 'non', libelle: 'Non', coefficient: 0 }, { code: 'peut', libelle: 'Peut-être', coefficient: 0.5 }] }
    const r1 = await traiterCreationReferentiel(req('POST', admin, { ...base, code: `t${suffixe}-bad`, definition: sansReponsePleine }))
    expect(r1.status).toBe(400)
    expect((await json(r1)).erreur).toMatch(/doit valoir 1/)
    const r2 = await traiterCreationReferentiel(req('POST', admin, { ...base, code: `t${suffixe}-bad2`, definition: { ...PETIT, niveaux: [{ seuilMin: 0, seuilMax: 60, libelle: 'a', message: 'm' }, { seuilMin: 50, seuilMax: 100, libelle: 'b', message: 'm' }] } }))
    expect((await json(r2)).erreur).toMatch(/sans trou ni chevauchement/)
    const r3 = await traiterCreationReferentiel(req('POST', admin, { ...base, code: 'Code Invalide', definition: PETIT }))
    expect(r3.status).toBe(400)
    const r4 = await traiterCreationReferentiel(req('POST', admin, { ...base, code: CODE, definition: PETIT }))
    expect(r4.status).toBe(409)
  })

  it('l’admin liste le catalogue ; le consultant et le client ne le voient pas', async () => {
    const r = await traiterCatalogueAutodiagnostic(req('GET', admin))
    expect(r.status).toBe(200)
    expect((await json(r)).referentiels.map((x: { code: string }) => x.code)).toContain(CODE)
    expect((await traiterCatalogueAutodiagnostic(req('GET', consultant))).status).toBe(403)
    expect((await traiterCatalogueAutodiagnostic(req('GET', adminEntreprise))).status).toBe(403)
  })
})

describe('Conduite d’une évaluation', () => {
  it('le consultant voit les référentiels, démarre une évaluation avec un site écrit à la main, répond par lots, termine', async () => {
    const liste = await json(await traiterListeAutodiagnostics(req('GET', consultant)))
    expect(liste.peutConduire).toBe(true)
    expect(liste.referentiels.map((x: { code: string }) => x.code)).toContain(CODE)

    const r = await creer({ nouveauSite: { nom: 'Atelier saisi librement', ville: 'Porto-Novo' } })
    expect(r.status, await r.clone().text()).toBe(201)
    const { id, reference } = await json(r)
    expect(reference).toMatch(/^AUD-\d{4}-[0-9A-F]{8}$/)
    let e = await evaluation(id)
    expect(e).toMatchObject({ statut: 'en_cours', site_nom: 'Atelier saisi librement', interlocuteur: 'M. Responsable' })

    expect((await repondre(id, { reponses: { 'a-1': 'oui' }, commentaires: { 'a-1': '  Constaté sur place. ' } })).status).toBe(200)
    expect((await repondre(id, { reponses: { 'a-2': 'non' } })).status).toBe(200)
    e = await evaluation(id)
    expect(e.reponses).toEqual({ 'a-1': 'oui', 'a-2': 'non' })
    expect(e.commentaires).toEqual({ 'a-1': 'Constaté sur place.' })
    // Retirer une réponse.
    expect((await repondre(id, { reponses: { 'a-2': null } })).status).toBe(200)
    expect((await evaluation(id)).reponses).toEqual({ 'a-1': 'oui' })

    const incomplet = await traiterTerminerAutodiagnostic(req('POST', consultant, {}), id)
    expect(incomplet.status).toBe(409)
    expect((await json(incomplet)).erreur).toMatch(/question\(s\) sans réponse/)
    await repondre(id, { reponses: { 'a-2': 'non', 'b-1': 'partiel' } })
    const fin = await traiterTerminerAutodiagnostic(req('POST', consultant, {}), id)
    expect(fin.status).toBe(200)
    expect((await json(fin)).resultat.globalScore).toBe(67) // (3×1 + 1×0 + 2×0,5) / 6 = 66,7 %
    e = await evaluation(id)
    expect(e).toMatchObject({ statut: 'terminee', score_global: 67, niveau_libelle: 'Haut' })
    expect((await repondre(id, { reponses: { 'a-1': 'non' } })).status).toBe(409)
  })

  it('réponse invalide refusée avec un message clair ; lot vide refusé', async () => {
    const { id } = await json(await creer())
    const r = await repondre(id, { reponses: { 'z-9': 'oui' } })
    expect(r.status).toBe(409)
    expect((await json(r)).erreur).toMatch(/Question inconnue/)
    expect((await repondre(id, { reponses: { 'a-1': 'peut-etre' } })).status).toBe(409)
    expect((await repondre(id, {})).status).toBe(400)
  })

  it('référentiel inconnu refusé ; origine étrangère refusée', async () => {
    expect((await traiterCreationAutodiagnostic(req('POST', consultant, { referentiel: 'inexistant' }))).status).toBe(404)
    const r = await traiterCreationAutodiagnostic(new Request(`${ORIGINE}/api/x`, { method: 'POST', headers: { host: HOTE, origin: 'http://evil.example', cookie: `ifecarm_session=${encodeURIComponent(consultant)}`, 'content-type': 'application/json' }, body: '{}' }))
    expect(r.status).toBe(403)
  })
})

describe('Droits par rôle', () => {
  it('admin d’entreprise et responsable QHSE : évaluations terminées seulement (liste, détail, rapport) ; jamais d’écriture', async () => {
    const id = await terminee()
    const brouillon = (await json(await creer())).id as string
    for (const jeton of [adminEntreprise, jetonQhse()]) {
      const liste = await json(await traiterListeAutodiagnostics(req('GET', jeton)))
      const ids = liste.evaluations.map((x: { id: string }) => x.id)
      expect(ids).toContain(id)
      expect(ids).not.toContain(brouillon)
      expect(liste.peutConduire).toBe(false)
      expect(liste.referentiels).toEqual([])
      expect((await traiterDetailAutodiagnostic(req('GET', jeton), id)).status).toBe(200)
      expect((await traiterDetailAutodiagnostic(req('GET', jeton), brouillon)).status).toBe(404)
      expect((await traiterCreationAutodiagnostic(req('POST', jeton, { referentiel: CODE }))).status).toBe(403)
      expect((await repondre(id, { reponses: { 'a-1': 'non' } }, jeton)).status).toBe(403)
      expect((await traiterTerminerAutodiagnostic(req('POST', jeton, {}), brouillon)).status).toBe(403)
      expect((await traiterSuppressionAutodiagnostic(req('DELETE', jeton), id)).status).toBe(403)
      expect((await traiterActionsAutodiagnostic(req('POST', jeton, { questionIds: ['a-2'] }), id)).status).toBe(403)
      expect((await traiterRapportAutodiagnostic(req('GET', jeton), id)).status).toBe(200)
    }
  })

  it('déclarant : aucun accès ; autre entreprise : module non activé', async () => {
    expect((await traiterListeAutodiagnostics(req('GET', jetonDeclarant()))).status).toBe(403)
    expect((await traiterResumeAutodiagnostic(req('GET', jetonDeclarant()))).status).toBe(403)
    expect((await traiterListeAutodiagnostics(req('GET', chezB))).status).toBe(403)
  })
})

describe('Actions, rapport, historique, tableau de bord', () => {
  it('actions depuis les écarts : une par question, écarts seulement, visibles dans le détail', async () => {
    const id = await terminee({ 'a-1': 'non', 'a-2': 'oui', 'b-1': 'partiel' })
    const hors = await traiterActionsAutodiagnostic(req('POST', consultant, { questionIds: ['a-2'] }), id)
    expect(hors.status).toBe(400) // a-2 est conforme : ce n'est pas un écart
    const r = await traiterActionsAutodiagnostic(req('POST', consultant, { questionIds: ['a-1', 'b-1'], responsable: 'M. Qualité', echeance: '2026-12-31' }), id)
    expect(r.status, await r.clone().text()).toBe(201)
    expect((await json(r)).crees).toHaveLength(2)
    const e = await evaluation(id)
    expect(e.actions.map((x: { question_id: string }) => x.question_id).sort()).toEqual(['a-1', 'b-1'])
    expect(e.actions[0]).toMatchObject({ statut: 'a_faire', responsable_nom: 'M. Qualité', echeance: '2026-12-31', libelle: expect.stringMatching(/^Faire /) })
    // Rejouer : rien de plus (une action par question).
    expect((await json(await traiterActionsAutodiagnostic(req('POST', consultant, { questionIds: ['a-1'] }), id))).crees).toHaveLength(0)
    expect((await traiterActionsAutodiagnostic(req('POST', consultant, { questionIds: [] }), id)).status).toBe(400)
    // Le client voit les actions de son évaluation.
    expect((await evaluation(id, adminEntreprise)).actions).toHaveLength(2)
    // Une évaluation qui a des actions ne se supprime pas.
    const sup = await traiterSuppressionAutodiagnostic(req('DELETE', admin), id)
    expect([403, 409]).toContain(sup.status)
  })

  it('actions refusées sur une évaluation non terminée', async () => {
    const { id } = await json(await creer())
    expect((await traiterActionsAutodiagnostic(req('POST', consultant, { questionIds: ['a-1'] }), id)).status).toBe(409)
  })

  it('rapport PDF : valide pour une évaluation terminée, refusé tant qu’elle est ouverte', async () => {
    const id = await terminee()
    const r = await traiterRapportAutodiagnostic(req('GET', consultant), id)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(r.headers.get('cache-control')).toMatch(/no-store/)
    expect((await PDFDocument.load(new Uint8Array(await r.arrayBuffer()))).getPageCount()).toBeGreaterThanOrEqual(2)
    const { id: ouverte } = await json(await creer())
    expect((await traiterRapportAutodiagnostic(req('GET', consultant), ouverte)).status).toBe(409)
  })

  it('historique : le score précédent et la comparaison par thème apparaissent ; le tableau de bord donne le dernier résultat', async () => {
    const code = `t${suffixe}-histo`
    expect((await traiterCreationReferentiel(req('POST', admin, { code, titre: 'Référentiel historique', description: 'D', dureeEstimeeMinutes: 5, avertissement: 'A', definition: PETIT }))).status).toBe(201)
    const faire = async (reponse: string) => {
      const { id } = await json(await traiterCreationAutodiagnostic(req('POST', consultant, { referentiel: code })))
      await repondre(id, { reponses: { 'a-1': reponse, 'a-2': reponse, 'b-1': reponse } })
      expect((await traiterTerminerAutodiagnostic(req('POST', consultant, {}), id)).status).toBe(200)
      return id as string
    }
    const premiere = await faire('non')
    const seconde = await faire('oui')
    const e1 = await evaluation(premiere)
    expect(e1.precedente).toBeNull()
    const e2 = await evaluation(seconde)
    expect(e2.precedente).toMatchObject({ id: premiere, score_global: 0 })
    expect(e2.precedente.themes).toEqual([{ code: 'a', score: 0 }, { code: 'b', score: 0 }])
    const liste = (await json(await traiterListeAutodiagnostics(req('GET', consultant)))).evaluations.find((x: { id: string }) => x.id === seconde)
    expect(liste.score_precedent).toBe(0)
    const resume = await json(await traiterResumeAutodiagnostic(req('GET', jetonQhse())))
    const dernier = resume.derniers.find((x: { referentiel_code: string }) => x.referentiel_code === code)
    expect(dernier).toMatchObject({ id: seconde, score_global: 100, score_precedent: 0 })
  })

  it('suppression : un brouillon par l’équipe ; une terminée par l’administrateur seulement', async () => {
    const { id } = await json(await creer())
    expect((await traiterSuppressionAutodiagnostic(req('DELETE', consultant), id)).status).toBe(200)
    const fin = await terminee()
    const refus = await traiterSuppressionAutodiagnostic(req('DELETE', consultant), fin)
    expect(refus.status).toBe(403)
  })
})

describe('Évolution du catalogue', () => {
  it('modifier ou désactiver un référentiel n’affecte pas les évaluations existantes ; supprimer est refusé s’il a servi', async () => {
    const id = await terminee()
    const liste = (await json(await traiterCatalogueAutodiagnostic(req('GET', admin)))).referentiels as { id: string, code: string }[]
    const ref = liste.find((x) => x.code === CODE)!
    expect((await traiterModificationReferentiel(req('PATCH', admin, { titre: 'Titre modifié', actif: false }), ref.id)).status).toBe(200)
    expect((await evaluation(id)).referentiel_titre).toBe(`Référentiel ${CODE}`)
    // Désactivé : plus proposé, plus de nouvelle évaluation.
    expect((await json(await traiterListeAutodiagnostics(req('GET', consultant)))).referentiels.map((x: { code: string }) => x.code)).not.toContain(CODE)
    expect((await creer()).status).toBe(404)
    expect((await traiterSuppressionReferentiel(req('DELETE', admin), ref.id)).status).toBe(409)
    // Réactivation.
    expect((await traiterModificationReferentiel(req('PATCH', admin, { titre: `Référentiel ${CODE}`, actif: true }), ref.id)).status).toBe(200)
    expect((await creer()).status).toBe(201)
  })

  it('un référentiel jamais utilisé se supprime', async () => {
    const code = `t${suffixe}-jetable`
    const r = await traiterCreationReferentiel(req('POST', admin, { code, titre: 'Jetable', description: 'D', dureeEstimeeMinutes: 5, avertissement: 'A', definition: PETIT }))
    const { id } = await json(r)
    expect((await traiterSuppressionReferentiel(req('DELETE', admin), id)).status).toBe(200)
  })
})

describe('Autodiagnostic chez un prospect', () => {
  const prospects: string[] = []
  afterAll(async () => { try { await migrate((c) => c.query('DELETE FROM entreprise WHERE id = ANY($1)', [prospects])) } catch { /* journal : nettoyage au mieux */ } })

  it('un prospect créé par un consultant a le module ; on y mène une évaluation ; l’historique suit à la conversion en client ; les autres modules de client restent refusés', async () => {
    const { withAuthenticatedUser, withTenant } = await import('@/db/tenant')
    const { creerProspect } = await import('@/inspections/prospect')
    const prospectId = await withAuthenticatedUser(f.consultantC1, (trx) => creerProspect(trx, { nom: `Prospect autodiag ${suffixe}`, pays: 'BJ', secteur: 'BTP' }))
    prospects.push(prospectId)

    const modules = await migrate(async (c) => (await c.query('SELECT module FROM abonnement_module WHERE entreprise_id = $1 ORDER BY module', [prospectId])).rows.map((r) => r.module))
    expect(modules).toEqual(['autodiagnostic', 'inspections', 'tableau_bord'])

    // Évaluation conduite chez le prospect (le consultant a l'accès en écriture accordé à la création).
    const jeton = await session(f.consultantC1, prospectId)
    const r = await traiterCreationAutodiagnostic(req('POST', jeton, { referentiel: CODE, interlocuteur: 'Dirigeant du prospect' }))
    expect(r.status, await r.clone().text()).toBe(201)
    const { id } = await json(r)
    expect((await repondre(id, { reponses: { 'a-1': 'oui', 'a-2': 'oui', 'b-1': 'oui' } }, jeton)).status).toBe(200)
    expect((await traiterTerminerAutodiagnostic(req('POST', jeton, {}), id)).status).toBe(200)

    // Les modules réservés aux clients restent interdits à un prospect (règle de la base).
    await expect(migrate((c) => c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'formations')", [prospectId]))).rejects.toThrow(/prospect/)

    // Conversion en client : l'évaluation est conservée.
    await migrate((c) => c.query("UPDATE entreprise SET statut_relation = 'client' WHERE id = $1", [prospectId]))
    const apres = await withTenant({ entrepriseId: prospectId, utilisateurId: f.consultantC1 }, async (trx) => (await trx.selectFrom('autodiagnostic').select(['id', 'statut']).execute()))
    expect(apres).toEqual([{ id, statut: 'terminee' }])
  })

  it('un prospect existant dont le module a été coupé n’est pas réactivé d’office (la migration ne touche pas à un abonnement existant)', async () => {
    const { withAuthenticatedUser } = await import('@/db/tenant')
    const { creerProspect } = await import('@/inspections/prospect')
    const prospectId = await withAuthenticatedUser(f.consultantC1, (trx) => creerProspect(trx, { nom: `Prospect coupé ${suffixe}`, pays: 'BJ' }))
    prospects.push(prospectId)
    await migrate((c) => c.query("UPDATE abonnement_module SET actif = false WHERE entreprise_id = $1 AND module = 'autodiagnostic'", [prospectId]))
    const jeton = await session(f.consultantC1, prospectId)
    expect((await traiterCreationAutodiagnostic(req('POST', jeton, { referentiel: CODE }))).status).toBe(403)
  })
})
