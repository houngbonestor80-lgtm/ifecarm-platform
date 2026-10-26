import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withPlatformAdmin, withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * B1 (migration 0047) — autodiagnostic : catalogue géré par l'admin, évaluations figées avec résultat calculé en base,
 * cloisonnement par rôle et par entreprise, actions issues des écarts. Tout passe par ifecarm_app (RLS) ; le rôle de
 * migration ne sert qu'à poser les comptes et à lire pour contrôler.
 */

let f: Fixtures
const suffixe = randomUUID().slice(0, 6)
const code = (n: string) => `t${suffixe}-${n}`
let qhse: string
let respSite: string
let declarant: string
let siteA: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const equipe = <T>(cb: (trx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>, entreprise = f.entrepriseA) =>
  withTenant({ entrepriseId: entreprise, utilisateurId: f.consultantC1 }, cb)
const client = <T>(u: string, cb: (trx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>, entreprise = f.entrepriseA) =>
  withTenant({ entrepriseId: entreprise, utilisateurId: u }, cb)
const admin = <T>(cb: (trx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
  withPlatformAdmin({ utilisateurId: f.adminPlateformeP1, operation: 'gerer_catalogue_autodiagnostic' }, cb as never) as Promise<T>

async function utilisateur(c: Client, label: string, role: string, site?: string): Promise<string> {
  const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseA, `${label}-${randomUUID().slice(0, 8)}@test.local`, label])
  await c.query('INSERT INTO role_utilisateur (utilisateur_id, role, site_id) VALUES ($1, $2, $3)', [u.id, role, site ?? null])
  return u.id
}

// Petit questionnaire de test : 2 thèmes, 4 questions (poids 1 à 3), échelle oui / partiel / non.
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
    { code: 'b', libelle: 'Thème B', questions: [
      { id: 'b-1', texte: 'Question B1', poids: 2, recommandation: 'Faire B1' },
      { id: 'b-2', texte: 'Question B2', poids: 2, recommandation: 'Faire B2' },
    ] },
  ],
}

const creerReferentiel = (c: string, definition: unknown, actif = true) => admin((trx) => sql`
  insert into referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition, actif)
  values (${c}, ${'Titre ' + c}, 'Description', 5, 'Indicatif.', ${JSON.stringify(definition)}::jsonb, ${actif})`.execute(trx))

const creerEvaluation = async (c: string, extra: { definition?: unknown, titre?: string } = {}) => (await equipe((trx) => sql<{ id: string, reference: string, referentiel_titre: string, definition: unknown, statut: string }>`
  insert into autodiagnostic (entreprise_id, referentiel_code, site_id, interlocuteur, conduit_par, referentiel_titre, definition)
  values (${f.entrepriseA}, ${c}, ${siteA}, 'M. Interlocuteur', ${f.consultantC1}, ${extra.titre ?? 'x'}, ${JSON.stringify(extra.definition ?? { pirate: true })}::jsonb)
  returning id, reference, referentiel_titre, definition, statut`.execute(trx))).rows[0]!

const repondre = (id: string, reponses: Record<string, string>, commentaires: Record<string, string> = {}) => equipe((trx) => sql`
  update autodiagnostic set reponses = ${JSON.stringify(reponses)}::jsonb, commentaires = ${JSON.stringify(commentaires)}::jsonb where id = ${id}`.execute(trx))
const terminer = (id: string) => equipe(async (trx) => (await sql<{ r: Record<string, unknown> }>`select terminer_autodiagnostic(${id}) as r`.execute(trx)).rows[0]!.r)
const toutRepondre = (def: typeof PETIT, v: string) => Object.fromEntries(def.themes.flatMap((t) => t.questions.map((q) => [q.id, v])))

/** Algorithme du site vitrine (shared/utils/autodiagnosticScoring.ts), repris tel quel : référence de comparaison. */
function scoreSite(ref: { echelleReponses: { code: string, coefficient: number }[], niveaux: { seuilMin: number, seuilMax: number, libelle: string }[], themes: { code: string, libelle: string, questions: { id: string, poids: number, recommandation: string }[] }[] }, answers: Record<string, string>) {
  const coef = new Map(ref.echelleReponses.map((o) => [o.code, o.coefficient]))
  let gp = 0; let gw = 0
  const themes: { code: string, score: number }[] = []
  const reco: { questionId: string, poids: number }[] = []
  for (const t of ref.themes) {
    let tp = 0; let tw = 0
    for (const q of t.questions) {
      const c = answers[q.id] !== undefined ? (coef.get(answers[q.id]!) ?? 0) : 0
      tp += q.poids * c; tw += q.poids
      if (c < 1) reco.push({ questionId: q.id, poids: q.poids })
    }
    themes.push({ code: t.code, score: tw > 0 ? Math.round((tp / tw) * 100) : 0 })
    gp += tp; gw += tw
  }
  const globalScore = gw > 0 ? Math.round((gp / gw) * 100) : 0
  const niveau = ref.niveaux.find((n) => globalScore >= n.seuilMin && globalScore <= n.seuilMax) ?? ref.niveaux[0]!
  reco.sort((a, b) => b.poids - a.poids)
  return { globalScore, niveau: niveau.libelle, themes, reco: reco.map((r) => r.questionId) }
}

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    siteA = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site autodiag') RETURNING id", [f.entrepriseA])).rows[0].id
    qhse = await utilisateur(c, 'qhse', 'responsable_qhse')
    respSite = await utilisateur(c, 'respsite', 'responsable_site', siteA)
    declarant = await utilisateur(c, 'declarant', 'declarant')
  })
  await creerReferentiel(code('petit'), PETIT)
})

afterAll(async () => {
  try {
    await migrate(async (c) => {
      await c.query('DELETE FROM autodiagnostic_action WHERE entreprise_id = ANY($1)', [[f.entrepriseA, f.entrepriseB]])
      await c.query('DELETE FROM action_corrective WHERE entreprise_id = ANY($1)', [[f.entrepriseA, f.entrepriseB]])
      await c.query("SET LOCAL app.platform_admin = 'true'").catch(() => undefined)
      await c.query("DELETE FROM referentiel_autodiagnostic WHERE code LIKE $1", [`t${suffixe}-%`])
    })
  } catch { /* nettoyage au mieux */ }
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('Catalogue des référentiels', () => {
  it('lu par l’équipe IFECARM, écrit par l’administrateur seulement ; invisible du client', async () => {
    expect((await equipe((trx) => sql<{ code: string }>`select code from referentiel_autodiagnostic where code = ${code('petit')}`.execute(trx))).rows).toHaveLength(1)
    await expect(equipe((trx) => sql`insert into referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition) values (${code('x')}, 't', 'd', 5, 'a', ${JSON.stringify(PETIT)}::jsonb)`.execute(trx))).rejects.toThrow(/row-level security/)
    expect((await equipe((trx) => sql`update referentiel_autodiagnostic set titre = 'modifié' where code = ${code('petit')}`.execute(trx))).numAffectedRows).toBe(0n)
    for (const u of [f.utilisateurA1, qhse, respSite, declarant]) {
      expect((await client(u, (trx) => sql`select 1 from referentiel_autodiagnostic`.execute(trx))).rows).toHaveLength(0)
    }
    await expect(client(f.utilisateurA1, (trx) => sql`insert into referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition) values (${code('y')}, 't', 'd', 5, 'a', ${JSON.stringify(PETIT)}::jsonb)`.execute(trx))).rejects.toThrow(/row-level security/)
  })

  it('un questionnaire invalide est refusé par la base (niveaux qui se chevauchent, doublon de question, coefficient, poids, échelle sans réponse pleine)', async () => {
    const mauvais: [string, unknown][] = [
      ['niveaux chevauchants', { ...PETIT, niveaux: [{ seuilMin: 0, seuilMax: 60, libelle: 'a', message: 'm' }, { seuilMin: 50, seuilMax: 100, libelle: 'b', message: 'm' }] }],
      ['niveaux ne couvrant pas 0-100', { ...PETIT, niveaux: [{ seuilMin: 0, seuilMax: 80, libelle: 'a', message: 'm' }] }],
      ['question en double', { ...PETIT, themes: [PETIT.themes[0], { ...PETIT.themes[1], questions: [{ id: 'a-1', texte: 'doublon', poids: 1, recommandation: 'r' }] }] }],
      ['coefficient 2', { ...PETIT, echelleReponses: [{ code: 'oui', libelle: 'Oui', coefficient: 2 }, { code: 'non', libelle: 'Non', coefficient: 0 }] }],
      ['aucune réponse à 1', { ...PETIT, echelleReponses: [{ code: 'partiel', libelle: 'P', coefficient: 0.5 }, { code: 'non', libelle: 'Non', coefficient: 0 }] }],
      ['poids 0', { ...PETIT, themes: [{ code: 'a', libelle: 'A', questions: [{ id: 'a-1', texte: 't', poids: 0, recommandation: 'r' }] }] }],
      ['thème sans question', { ...PETIT, themes: [{ code: 'a', libelle: 'A', questions: [] }] }],
      ['pas un objet', 'texte'],
    ]
    for (const [libelle, def] of mauvais) {
      await expect(creerReferentiel(code('mauvais'), def), libelle).rejects.toThrow(/check|violates/i)
    }
  })

  it('les 5 référentiels ISO du site sont valides pour la base', async () => {
    const dossier = path.join(process.cwd(), 'src', 'autodiagnostic', 'referentiels')
    const fichiers = readdirSync(dossier).filter((n) => n.endsWith('.json'))
    expect(fichiers.length).toBe(5)
    for (const nom of fichiers) {
      const r = JSON.parse(readFileSync(path.join(dossier, nom), 'utf8'))
      await creerReferentiel(code(r.referentiel), { echelleReponses: r.echelleReponses, niveaux: r.niveaux, themes: r.themes })
    }
  })
})

describe('Évaluation : création, réponses, résultat', () => {
  it('le questionnaire est COPIÉ du catalogue (le navigateur ne peut ni le fournir ni l’altérer) ; référence AUD-AAAA-xxxxxxxx ; référentiel inconnu ou désactivé refusé', async () => {
    const e = await creerEvaluation(code('petit'), { definition: { pirate: true }, titre: 'Titre pirate' })
    expect(e.statut).toBe('en_cours')
    expect(e.referentiel_titre).toBe('Titre ' + code('petit'))
    expect(e.definition).toEqual(PETIT)
    expect(e.reference).toMatch(/^AUD-\d{4}-[0-9A-F]{8}$/)
    await expect(equipe((trx) => sql`insert into autodiagnostic (entreprise_id, referentiel_code) values (${f.entrepriseA}, 'inexistant')`.execute(trx))).rejects.toThrow(/inconnu ou désactivé/)
    await creerReferentiel(code('inactif'), PETIT, false)
    await expect(equipe((trx) => sql`insert into autodiagnostic (entreprise_id, referentiel_code) values (${f.entrepriseA}, ${code('inactif')})`.execute(trx))).rejects.toThrow(/inconnu ou désactivé/)
  })

  it('modifier le catalogue ensuite ne change pas une évaluation existante', async () => {
    const e = await creerEvaluation(code('petit'))
    await admin((trx) => sql`update referentiel_autodiagnostic set titre = 'Nouveau titre', definition = ${JSON.stringify({ ...PETIT, niveaux: [{ seuilMin: 0, seuilMax: 100, libelle: 'Unique', message: 'm' }] })}::jsonb where code = ${code('petit')}`.execute(trx))
    const apres = (await equipe((trx) => sql<{ definition: { niveaux: unknown[] }, referentiel_titre: string }>`select definition, referentiel_titre from autodiagnostic where id = ${e.id}`.execute(trx))).rows[0]!
    expect(apres.definition.niveaux).toHaveLength(2)
    expect(apres.referentiel_titre).toBe('Titre ' + code('petit'))
    await admin((trx) => sql`update referentiel_autodiagnostic set titre = ${'Titre ' + code('petit')}, definition = ${JSON.stringify(PETIT)}::jsonb where code = ${code('petit')}`.execute(trx))
  })

  it('réponses et commentaires validés contre le questionnaire copié ; identité et questionnaire jamais modifiables', async () => {
    const e = await creerEvaluation(code('petit'))
    await expect(repondre(e.id, { 'z-9': 'oui' })).rejects.toThrow(/Question inconnue/)
    await expect(repondre(e.id, { 'a-1': 'peut-etre' })).rejects.toThrow(/Réponse inconnue/)
    await expect(repondre(e.id, { 'a-1': 'oui' }, { 'z-9': 'x' })).rejects.toThrow(/question inconnue/i)
    await expect(repondre(e.id, { 'a-1': 'oui' }, { 'a-1': 'x'.repeat(1001) })).rejects.toThrow(/trop long/)
    await repondre(e.id, { 'a-1': 'oui' }, { 'a-1': 'Constaté sur place.' })
    await expect(equipe((trx) => sql`update autodiagnostic set definition = ${JSON.stringify({ ...PETIT, themes: [PETIT.themes[0]] })}::jsonb where id = ${e.id}`.execute(trx))).rejects.toThrow(/ne changent pas/)
    await expect(equipe((trx) => sql`update autodiagnostic set reference = 'AUD-2000-00000000' where id = ${e.id}`.execute(trx))).rejects.toThrow(/ne changent pas/)
    await expect(equipe((trx) => sql`update autodiagnostic set entreprise_id = ${f.entrepriseB} where id = ${e.id}`.execute(trx))).rejects.toThrow()
  })

  it('terminer exige toutes les réponses ; le résultat est calculé par la base (jamais falsifiable) ; terminée = définitive', async () => {
    const e = await creerEvaluation(code('petit'))
    await repondre(e.id, { 'a-1': 'oui', 'a-2': 'non', 'b-1': 'partiel' })
    await expect(terminer(e.id)).rejects.toThrow(/1 question\(s\) sans réponse sur 4/)
    // Falsification directe du résultat : refusée.
    await expect(equipe((trx) => sql`update autodiagnostic set statut = 'terminee', resultat = '{"globalScore":100}'::jsonb, score_global = 100, niveau_libelle = 'Haut', terminee_le = now() where id = ${e.id}`.execute(trx))).rejects.toThrow(/calculé par la base/)
    await repondre(e.id, { 'a-1': 'oui', 'a-2': 'non', 'b-1': 'partiel', 'b-2': 'non' })
    const r = await terminer(e.id) as { globalScore: number, niveau: { libelle: string }, themes: { code: string, score: number }[], recommendations: { questionId: string }[] }
    // A : (3×1 + 1×0) / 4 = 75 % ; B : (2×0,5 + 2×0) / 4 = 25 % ; global : 4 / 8 = 50 %.
    expect(r.globalScore).toBe(50)
    expect(r.niveau.libelle).toBe('Haut')
    expect(r.themes).toEqual([{ code: 'a', libelle: 'Thème A', score: 75 }, { code: 'b', libelle: 'Thème B', score: 25 }])
    expect(r.recommendations.map((x) => x.questionId)).toEqual(['b-1', 'b-2', 'a-2']) // poids décroissant, ordre du questionnaire à poids égal

    const ligne = (await equipe((trx) => sql<{ statut: string, score_global: number, niveau_libelle: string, terminee_le: Date | null }>`select statut, score_global, niveau_libelle, terminee_le from autodiagnostic where id = ${e.id}`.execute(trx))).rows[0]!
    expect(ligne).toMatchObject({ statut: 'terminee', score_global: 50, niveau_libelle: 'Haut' })
    expect(ligne.terminee_le).toBeTruthy()
    await expect(repondre(e.id, { 'a-1': 'non' })).rejects.toThrow(/définitive/)
    await expect(terminer(e.id)).rejects.toThrow(/déjà terminée/)
    await expect(equipe((trx) => sql`update autodiagnostic set interlocuteur = 'Autre' where id = ${e.id}`.execute(trx))).rejects.toThrow(/définitive/)
  })

  it('même résultat que l’algorithme du site vitrine sur les 5 référentiels réels (réponses tirées au hasard)', async () => {
    const dossier = path.join(process.cwd(), 'src', 'autodiagnostic', 'referentiels')
    let graine = 12345
    const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648 }
    for (const nom of readdirSync(dossier).filter((n) => n.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(path.join(dossier, nom), 'utf8'))
      for (let essai = 0; essai < 4; essai++) {
        const codes = r.echelleReponses.map((o: { code: string }) => o.code)
        const reponses: Record<string, string> = {}
        for (const t of r.themes) for (const q of t.questions) reponses[q.id] = codes[Math.floor(hasard() * codes.length)]
        const e = await creerEvaluation(code(r.referentiel))
        await repondre(e.id, reponses)
        const base = await terminer(e.id) as { globalScore: number, niveau: { libelle: string }, themes: { code: string, score: number }[], recommendations: { questionId: string }[] }
        const attendu = scoreSite(r, reponses)
        expect(base.globalScore, `${r.referentiel} #${essai}`).toBe(attendu.globalScore)
        expect(base.niveau.libelle).toBe(attendu.niveau)
        expect(base.themes.map((t) => ({ code: t.code, score: t.score }))).toEqual(attendu.themes)
        expect(base.recommendations.map((x) => x.questionId)).toEqual(attendu.reco)
      }
    }
  })
})

describe('Cloisonnement', () => {
  let brouillon: string
  let terminee: string

  beforeAll(async () => {
    brouillon = (await creerEvaluation(code('petit'))).id
    const e = await creerEvaluation(code('petit'))
    await repondre(e.id, toutRepondre(PETIT, 'oui'))
    await terminer(e.id)
    terminee = e.id
  })

  const ids = (u: string, entreprise = f.entrepriseA) => client(u, async (trx) => (await sql<{ id: string }>`select id from autodiagnostic`.execute(trx)).rows.map((r) => r.id), entreprise)

  it('équipe : tout (brouillons compris) ; admin d’entreprise et responsable QHSE : terminées seulement', async () => {
    const equipeVoit = await ids(f.consultantC1)
    expect(equipeVoit).toEqual(expect.arrayContaining([brouillon, terminee]))
    for (const u of [f.utilisateurA1, qhse]) {
      const vus = await ids(u)
      expect(vus).toContain(terminee)
      expect(vus).not.toContain(brouillon)
    }
  })

  it('responsable de site et déclarant : rien, ni évaluations ni liens d’actions ni vue', async () => {
    for (const u of [respSite, declarant]) {
      expect(await ids(u)).toEqual([])
      expect((await client(u, (trx) => sql`select 1 from v_autodiagnostic_dernier`.execute(trx))).rows).toHaveLength(0)
      expect((await client(u, (trx) => sql`select 1 from autodiagnostic_action`.execute(trx))).rows).toHaveLength(0)
    }
  })

  it('l’autre entreprise ne voit rien de l’entreprise A, et l’équipe positionnée sur B non plus', async () => {
    expect(await ids(f.utilisateurB1, f.entrepriseB)).toEqual([])
    expect(await ids(f.consultantC1, f.entrepriseB)).toEqual([])
    // Terminer ou modifier l'évaluation de A en étant positionné sur B : introuvable.
    await expect(equipe(async (trx) => sql`select terminer_autodiagnostic(${brouillon})`.execute(trx), f.entrepriseB)).rejects.toThrow(/introuvable/)
    expect((await equipe((trx) => sql`update autodiagnostic set interlocuteur = 'x' where id = ${brouillon}`.execute(trx), f.entrepriseB)).numAffectedRows).toBe(0n)
  })

  it('le client n’écrit jamais : création, mise à jour, suppression, fin d’évaluation refusées', async () => {
    for (const u of [f.utilisateurA1, qhse, respSite, declarant]) {
      await expect(client(u, (trx) => sql`insert into autodiagnostic (entreprise_id, referentiel_code) values (${f.entrepriseA}, ${code('petit')})`.execute(trx))).rejects.toThrow(/row-level security/)
      expect((await client(u, (trx) => sql`update autodiagnostic set interlocuteur = 'x' where id = ${brouillon}`.execute(trx))).numAffectedRows).toBe(0n)
      expect((await client(u, (trx) => sql`delete from autodiagnostic where id = ${brouillon}`.execute(trx))).numAffectedRows).toBe(0n)
      await expect(client(u, (trx) => sql`select terminer_autodiagnostic(${brouillon})`.execute(trx))).rejects.toThrow(/Réservé à l'équipe/)
    }
  })

  it('suppression : brouillon par l’équipe ; terminée par l’administrateur seulement', async () => {
    const e = await creerEvaluation(code('petit'))
    expect((await equipe((trx) => sql`delete from autodiagnostic where id = ${e.id}`.execute(trx))).numAffectedRows).toBe(1n)
    await expect(equipe((trx) => sql`delete from autodiagnostic where id = ${terminee}`.execute(trx))).rejects.toThrow(/seul l'administrateur/)
    const jetable = await creerEvaluation(code('petit'))
    await repondre(jetable.id, toutRepondre(PETIT, 'non'))
    await terminer(jetable.id)
    const parAdmin = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.adminPlateformeP1 }, (trx) => sql`delete from autodiagnostic where id = ${jetable.id}`.execute(trx))
    expect(parAdmin.numAffectedRows).toBe(1n)
  })

  it('dernier résultat par référentiel avec le précédent (vue du tableau de bord) ; le client la lit pour son entreprise seulement', async () => {
    const c = code('histo')
    await creerReferentiel(c, PETIT)
    const e1 = await creerEvaluation(c)
    await repondre(e1.id, toutRepondre(PETIT, 'non')); await terminer(e1.id)
    await migrate((cl) => cl.query("UPDATE autodiagnostic SET realise_le = CURRENT_DATE - 400 WHERE id = $1", [e1.id])).catch(() => undefined)
    const e2 = await creerEvaluation(c)
    await repondre(e2.id, toutRepondre(PETIT, 'oui')); await terminer(e2.id)
    const vue = await client(f.utilisateurA1, async (trx) => (await sql<{ id: string, score_global: number, score_precedent: number | null }>`select id, score_global, score_precedent from v_autodiagnostic_dernier where referentiel_code = ${c}`.execute(trx)).rows)
    expect(vue).toHaveLength(1)
    expect(vue[0]).toMatchObject({ id: e2.id, score_global: 100, score_precedent: 0 })
    expect((await client(f.utilisateurB1, (trx) => sql`select 1 from v_autodiagnostic_dernier`.execute(trx), f.entrepriseB)).rows).toHaveLength(0)
  })
})

describe('Actions issues des écarts', () => {
  let terminee: string
  let brouillon: string

  const creerAction = (origine: string, entreprise = f.entrepriseA, reference = `ACT-T${randomUUID().slice(0, 6)}`) => equipe(async (trx) => (await sql<{ id: string }>`
    insert into action_corrective (entreprise_id, reference, origine_type, origine_id, libelle) values (${entreprise}, ${reference}, 'audit', ${origine}, 'Faire B1') returning id`.execute(trx)).rows[0]!.id, entreprise)

  beforeAll(async () => {
    const e = await creerEvaluation(code('petit'))
    await repondre(e.id, toutRepondre(PETIT, 'non'))
    await terminer(e.id)
    terminee = e.id
    brouillon = (await creerEvaluation(code('petit'))).id
  })

  it('une action « audit » exige une évaluation TERMINÉE de la même entreprise', async () => {
    await expect(creerAction(brouillon)).rejects.toThrow(/autodiagnostic terminé/)
    await expect(creerAction(randomUUID())).rejects.toThrow(/autodiagnostic terminé/)
    await expect(equipe((trx) => sql`insert into action_corrective (entreprise_id, reference, origine_type, libelle) values (${f.entrepriseA}, 'ACT-SANS-ORIGINE', 'audit', 'x')`.execute(trx))).rejects.toThrow(/autodiagnostic terminé/)
    // L'évaluation de A ne peut pas être l'origine d'une action de B.
    await expect(equipe((trx) => sql`insert into action_corrective (entreprise_id, reference, origine_type, origine_id, libelle) values (${f.entrepriseB}, 'ACT-B-INTRUS', 'audit', ${terminee}, 'x')`.execute(trx), f.entrepriseB)).rejects.toThrow(/autodiagnostic terminé/)
    expect(await creerAction(terminee)).toBeTruthy()
  })

  it('lien question → action : une action par question, question du questionnaire, action de la bonne évaluation', async () => {
    const action = await creerAction(terminee)
    await equipe((trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${terminee}, ${f.entrepriseA}, 'b-1', ${action})`.execute(trx))
    const autre = await creerAction(terminee)
    await expect(equipe((trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${terminee}, ${f.entrepriseA}, 'b-1', ${autre})`.execute(trx))).rejects.toThrow(/duplicate|unique/i)
    await expect(equipe((trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${terminee}, ${f.entrepriseA}, 'z-9', ${autre})`.execute(trx))).rejects.toThrow(/Question inconnue/)
    const horsEval = await equipe(async (trx) => (await sql<{ id: string }>`insert into action_corrective (entreprise_id, reference, origine_type, libelle) values (${f.entrepriseA}, ${'ACT-LIBRE-' + randomUUID().slice(0, 5)}, 'autre', 'libre') returning id`.execute(trx)).rows[0]!.id)
    await expect(equipe((trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${terminee}, ${f.entrepriseA}, 'a-1', ${horsEval})`.execute(trx))).rejects.toThrow(/origine audit/)
    // Le client n'écrit pas de lien.
    await expect(client(f.utilisateurA1, (trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${terminee}, ${f.entrepriseA}, 'a-2', ${autre})`.execute(trx))).rejects.toThrow(/row-level security/)
  })

  it('une évaluation qui a des actions ne peut pas être supprimée (même par l’administrateur)', async () => {
    const e = await creerEvaluation(code('petit'))
    await repondre(e.id, toutRepondre(PETIT, 'non')); await terminer(e.id)
    const action = await creerAction(e.id)
    await equipe((trx) => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${e.id}, ${f.entrepriseA}, 'a-1', ${action})`.execute(trx))
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.adminPlateformeP1 }, (trx) => sql`delete from autodiagnostic where id = ${e.id}`.execute(trx))).rejects.toThrow(/foreign key|viole|violates/i)
  })

  it('les actions d’origine audit sont visibles du client de l’entreprise (comme celles des inspections), pas d’une autre entreprise', async () => {
    const action = await creerAction(terminee, f.entrepriseA, 'ACT-VISIBLE-T1')
    const vues = await client(f.utilisateurA1, async (trx) => (await sql<{ id: string }>`select id from action_corrective where origine_type = 'audit'`.execute(trx)).rows.map((r) => r.id))
    expect(vues).toContain(action)
    const chezB = await client(f.utilisateurB1, async (trx) => (await sql<{ id: string }>`select id from action_corrective where origine_type = 'audit'`.execute(trx)).rows.map((r) => r.id), f.entrepriseB)
    expect(chezB).not.toContain(action)
  })
})

describe('Module', () => {
  it('« autodiagnostic » est un module activable par entreprise', async () => {
    await migrate((c) => c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'autodiagnostic')", [f.entrepriseA]))
    await expect(migrate((c) => c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inconnu')", [f.entrepriseA]))).rejects.toThrow(/check/i)
  })
})
