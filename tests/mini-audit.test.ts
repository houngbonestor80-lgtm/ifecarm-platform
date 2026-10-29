import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterConnexion } from '@/auth/routes'
import { withAuthenticatedUser, withTenant, withoutTenant } from '@/db/tenant'
import { lireResultat } from '@/mini-audit/service'
import { traiterConversionMiniAudit, traiterEnvoiMiniAudit, traiterListeMiniAudits, traiterQuestionnairesMiniAudit, traiterSuiviMiniAudit } from '@/mini-audit/routes'
import type { Courriel } from '@/notifications/email'
import { libererA2f } from './aide-a2f'
import { corpsConnexion, creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Mini-audit gratuit public (migration 0052) : envoi sans compte (réponses complètes, score calculé en base, limites),
 * lecture par code de suivi, aucune lecture ni écriture directe pour le public ni pour un client, suivi et conversion
 * en prospect par l'équipe IFECARM.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const suffixe = randomUUID().slice(0, 6)
const CODE = `t${suffixe}-mini`
const CODE_PRIVE = `t${suffixe}-prive`

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
const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ipAuHasard = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const req = (methode: string, corps?: unknown, entetes: Record<string, string> = {}) => new Request(`${ORIGINE}/api/x`, {
  method: methode,
  headers: { host: HOTE, origin: ORIGINE, ...(corps !== undefined ? { 'content-type': 'application/json' } : {}), ...entetes },
  body: corps === undefined ? undefined : JSON.stringify(corps),
})
const avecSession = (jeton: string, methode: string, corps?: unknown) => req(methode, corps, { cookie: `ifecarm_session=${encodeURIComponent(jeton)}` })
async function session(id: string): Promise<string> {
  const r = await traiterConnexion(req('POST', JSON.parse(corpsConnexion(emails.get(id))), { 'x-forwarded-for': ipAuHasard() }))
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  return jeton
}
const json = async (r: Response) => (await r.clone().json()) as Record<string, any>

const contact = (extra: Record<string, unknown> = {}) => ({
  nom: 'Awa Dossou', fonction: 'Directrice', entreprise: `Société ${randomUUID().slice(0, 6)}`, email: `awa-${randomUUID().slice(0, 8)}@test.local`,
  telephone: '+229 01 97 00 00 00', pays: 'BJ', secteur: 'BTP', effectif: '10-49', consentement: true, ...extra,
})
const REPONSES = { 'a-1': 'oui', 'a-2': 'non', 'b-1': 'partiel' }
const envois: Courriel[] = []
const envoyer = async (c: Courriel) => { envois.push(c) }
const envoyerMiniAudit = (corps: Record<string, unknown>, ip = ipAuHasard()) =>
  traiterEnvoiMiniAudit(req('POST', { questionnaire: CODE, reponses: REPONSES, contact: contact(), ...corps }, { 'x-forwarded-for': ip }), envoyer)

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.consultantC1, f.adminPlateformeP1, f.utilisateurA1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    for (const [code, pub] of [[CODE, true], [CODE_PRIVE, false]] as const) {
      await c.query(`INSERT INTO referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition, public)
                     VALUES ($1, $2, 'Description', 3, 'Indicatif.', $3, $4)`, [code, `Titre ${code}`, JSON.stringify(PETIT), pub])
    }
  })
})

afterAll(async () => {
  await migrate(async (c) => {
    await c.query("DELETE FROM mini_audit WHERE referentiel_code = ANY($1)", [[CODE, CODE_PRIVE]])
    await c.query('DELETE FROM referentiel_autodiagnostic WHERE code = ANY($1)', [[CODE, CODE_PRIVE]])
  })
  await nettoyerFixtures(f)
})

describe('Public : questionnaires et envoi', () => {
  it('seuls les questionnaires publics et actifs sont proposés, avec les pays', async () => {
    const r = await json(await traiterQuestionnairesMiniAudit())
    const codes = r.questionnaires.map((q: { code: string }) => q.code)
    expect(codes).toContain(CODE)
    expect(codes).not.toContain(CODE_PRIVE)
    expect(r.pays.map((p: { code: string }) => p.code)).toContain('BJ')
  })

  it('envoi complet : code de suivi, score calculé par la base, e-mail au prospect et alerte aux administrateurs', async () => {
    envois.length = 0
    const c = contact()
    // Un score envoyé par le navigateur est ignoré.
    const r = await envoyerMiniAudit({ contact: c, score: 100, resultat: { globalScore: 100 } })
    expect(r.status, await r.clone().text()).toBe(201)
    const { code, score, niveau } = await json(r)
    expect(code).toMatch(/^MA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    // (3×1 + 1×0 + 2×0,5) / 6 = 66,7 → 67 %.
    expect(score).toBe(67)
    expect(niveau).toBe('Haut')
    expect(envois[0]).toMatchObject({ a: c.email })
    expect(envois[0]!.texte).toContain(code)
    expect(envois[0]!.texte).toContain('Faire A2')
    expect(envois.slice(1).map((m) => m.a)).toContain(emails.get(f.adminPlateformeP1))
    expect(envois.find((m) => m.a === emails.get(f.adminPlateformeP1))!.texte).toContain(c.telephone)
  })

  it('le résultat se lit avec le code seul, sans jamais l’e-mail ni le téléphone ; code inconnu : rien', async () => {
    const { code } = await json(await envoyerMiniAudit({}))
    const r = await lireResultat(code)
    expect(r).toMatchObject({ code_suivi: code, referentiel_titre: `Titre ${CODE}` })
    expect(r!.resultat.globalScore).toBe(67)
    expect(JSON.stringify(r)).not.toMatch(/@test\.local|97 00 00/)
    expect(await lireResultat(code.toLowerCase())).toBeTruthy()
    expect(await lireResultat('MA-AAAA-AAAA-AAAA')).toBeUndefined()
    expect(await lireResultat('nimporte quoi')).toBeUndefined()
  })

  it('refus : réponses incomplètes ou inconnues, questionnaire privé, consentement absent, coordonnées invalides, champ piège, autre origine', async () => {
    const refus = async (corps: Record<string, unknown>, motif: RegExp) => {
      const r = await envoyerMiniAudit(corps)
      expect(r.status).toBe(400)
      expect((await json(r)).erreur).toMatch(motif)
    }
    await refus({ reponses: { 'a-1': 'oui', 'a-2': 'non' } }, /toutes les questions/)
    await refus({ reponses: { ...REPONSES, 'z-9': 'oui' } }, /toutes les questions/)
    await refus({ reponses: { ...REPONSES, 'a-1': 'peut-etre' } }, /toutes les questions/)
    await refus({ questionnaire: CODE_PRIVE }, /introuvable/)
    await refus({ contact: contact({ consentement: false }) }, /accord/)
    await refus({ contact: contact({ email: 'pas-un-email' }) }, /invalides/)
    await refus({ contact: contact({ entreprise: '' }) }, /invalides/)
    await refus({ contact: contact({ pays: 'ZZ' }) }, /invalides/)
    await refus({ contact: contact({ telephone: '<script>' }) }, /invalides/)
    await refus({ siteWeb: 'http://spam' }, /refusée/)
    const autre = new Request(`${ORIGINE}/api/x`, { method: 'POST', headers: { host: HOTE, origin: 'https://pirate.example', 'content-type': 'application/json' }, body: '{}' })
    expect((await traiterEnvoiMiniAudit(autre, envoyer)).status).toBe(403)
  })

  it('limites : 5 demandes par heure et par adresse IP, 3 par jour et par e-mail (429)', async () => {
    const ip = ipAuHasard()
    for (let i = 0; i < 5; i++) expect((await envoyerMiniAudit({}, ip)).status).toBe(201)
    const r = await envoyerMiniAudit({}, ip)
    expect(r.status).toBe(429)
    expect((await json(r)).erreur).toMatch(/une heure/)

    const meme = contact()
    for (let i = 0; i < 3; i++) expect((await envoyerMiniAudit({ contact: meme })).status).toBe(201)
    expect((await envoyerMiniAudit({ contact: { ...meme, email: meme.email.toUpperCase() } })).status).toBe(429)
  })
})

describe('Cloisonnement', () => {
  it('sans compte ni client : aucune ligne lisible, aucune écriture directe', async () => {
    await envoyerMiniAudit({})
    expect((await withoutTenant((trx) => trx.selectFrom('mini_audit').select('id').execute()))).toEqual([])
    expect((await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => trx.selectFrom('mini_audit').select('id').execute()))).toEqual([])
    await expect(withoutTenant((trx) => sql`insert into mini_audit (code_suivi) values ('MA-AAAA-AAAA-AAAA')`.execute(trx))).rejects.toThrow(/permission denied/)
    await expect(withAuthenticatedUser(f.consultantC1, (trx) => sql`update mini_audit set score_global = 100`.execute(trx))).rejects.toThrow(/permission denied/)
    await expect(withAuthenticatedUser(f.consultantC1, (trx) => sql`delete from mini_audit`.execute(trx))).rejects.toThrow(/permission denied/)
  })

  it('un client ne peut ni suivre ni convertir une demande', async () => {
    const { code } = await json(await envoyerMiniAudit({}))
    const id = (await migrate((c) => c.query('SELECT id FROM mini_audit WHERE code_suivi = $1', [code]))).rows[0].id
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => sql`select suivre_mini_audit(${id}::uuid, 'contacte')`.execute(trx))).rejects.toThrow(/Réservé/)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => sql`select convertir_mini_audit(${id}::uuid)`.execute(trx))).rejects.toThrow(/Réservé/)
    const client = await session(f.utilisateurA1)
    expect((await traiterListeMiniAudits(avecSession(client, 'GET'))).status).toBe(403)
    expect((await traiterSuiviMiniAudit(avecSession(client, 'POST', { statut: 'contacte' }), id)).status).toBe(403)
    expect((await traiterConversionMiniAudit(avecSession(client, 'POST', {}), id)).status).toBe(403)
    expect((await traiterListeMiniAudits(req('GET'))).status).toBe(401)
  })
})

describe('Équipe IFECARM : suivi et conversion', () => {
  it('le consultant voit les demandes, les marque contactées, puis convertit en prospect (coordonnées, service « audit », accès, journal)', async () => {
    const c = contact()
    const { code } = await json(await envoyerMiniAudit({ contact: c }))
    const consultant = await session(f.consultantC1)
    const liste = (await json(await traiterListeMiniAudits(avecSession(consultant, 'GET')))).demandes as { id: string, code_suivi: string, email: string, statut: string }[]
    const d = liste.find((x) => x.code_suivi === code)!
    expect(d).toMatchObject({ email: c.email, statut: 'nouveau' })

    expect((await traiterSuiviMiniAudit(avecSession(consultant, 'POST', { statut: 'contacte' }), d.id)).status).toBe(200)
    expect((await traiterSuiviMiniAudit(avecSession(consultant, 'POST', { statut: 'converti' }), d.id)).status).toBe(409)

    const r = await traiterConversionMiniAudit(avecSession(consultant, 'POST', {}), d.id)
    expect(r.status, await r.clone().text()).toBe(201)
    const { id: prospect } = await json(r)
    const e = (await migrate((cl) => cl.query(`SELECT e.nom, e.pays, e.secteur, e.telephone, e.email_contact, e.statut_relation, e.services_souhaites,
        (SELECT ecriture FROM acces_consultant a WHERE a.entreprise_id = e.id AND a.utilisateur_id = $2) AS ecriture,
        (SELECT count(*)::int FROM journal_audit j WHERE j.objet_type = 'mini_audit' AND j.objet_id = $3) AS journal,
        (SELECT statut FROM mini_audit WHERE id = $3) AS statut
      FROM entreprise e WHERE e.id = $1`, [prospect, f.consultantC1, d.id]))).rows[0]
    expect(e).toMatchObject({ nom: c.entreprise, pays: 'BJ', secteur: 'BTP', telephone: c.telephone, email_contact: c.email, statut_relation: 'prospect',
      services_souhaites: ['audit'], ecriture: true, journal: 1, statut: 'converti' })

    // Close : ni nouvelle conversion ni changement de suivi.
    expect((await traiterConversionMiniAudit(avecSession(consultant, 'POST', {}), d.id)).status).toBe(409)
    expect((await traiterSuiviMiniAudit(avecSession(consultant, 'POST', { statut: 'nouveau' }), d.id)).status).toBe(409)
    await migrate((cl) => cl.query('DELETE FROM entreprise WHERE id = $1', [prospect])).catch(() =>
      migrate((cl) => cl.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [prospect])))
  })

  it('« sans suite » est définitif ; demande inconnue : 404', async () => {
    const { code } = await json(await envoyerMiniAudit({}))
    const id = (await migrate((c) => c.query('SELECT id FROM mini_audit WHERE code_suivi = $1', [code]))).rows[0].id
    const admin = await session(f.adminPlateformeP1)
    expect((await traiterSuiviMiniAudit(avecSession(admin, 'POST', { statut: 'sans_suite' }), id)).status).toBe(200)
    expect((await traiterConversionMiniAudit(avecSession(admin, 'POST', {}), id)).status).toBe(409)
    expect((await traiterSuiviMiniAudit(avecSession(admin, 'POST', { statut: 'contacte' }), randomUUID())).status).toBe(404)
  })
})
