import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetonDepuisRequete } from '@/auth/http'
import { traiterConnexion } from '@/auth/routes'
import { withAuthenticatedUser, withTenant } from '@/db/tenant'
import { messageRelance } from '@/opportunites/messages'
import { traiterListeOpportunites, traiterSuiviOpportunite } from '@/opportunites/routes'
import { lienWhatsApp, numeroWhatsApp } from '@/ui/whatsapp'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, MOT_DE_PASSE_FIXTURES, type Fixtures } from './fixtures'

/**
 * Opportunités de vente (migration 0053) : échéances regroupées par entreprise et par objet, périmètre du consultant
 * (ses mandats) ou de l'admin (tous), jamais d'un client ; suivi qui couvre les échéances connues et se rouvre quand une
 * nouvelle apparaît ; résumé hebdomadaire une fois par semaine ; messages et liens WhatsApp prérédigés.
 */

const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const suffixe = randomUUID().slice(0, 6)
let f: Fixtures
const emails = new Map<string, string>()
let formation: string
let sessionB: string
let typeHab: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ipAuHasard = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const req = (methode: string, corps?: unknown, entetes: Record<string, string> = {}, url = `${ORIGINE}/api/x`) => new Request(url, {
  method: methode,
  headers: { host: HOTE, origin: ORIGINE, ...(corps !== undefined ? { 'content-type': 'application/json' } : {}), ...entetes },
  body: corps === undefined ? undefined : JSON.stringify(corps),
})
async function session(id: string): Promise<string> {
  const r = await traiterConnexion(req('POST', { email: emails.get(id), motDePasse: MOT_DE_PASSE_FIXTURES }, { 'x-forwarded-for': ipAuHasard() }))
  const jeton = jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]! } }))!
  await libererA2f(jeton)
  return jeton
}
const cookie = (jeton: string) => ({ cookie: `ifecarm_session=${encodeURIComponent(jeton)}` })
const json = async (r: Response) => (await r.clone().json()) as Record<string, any>

async function salarie(c: Client, entreprise: string, nom: string): Promise<string> {
  return (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom) VALUES ($1, $2, 'Test') RETURNING id", [entreprise, nom])).rows[0].id
}
async function attestation(c: Client, entreprise: string, session: string, salarieId: string, dansJours: number): Promise<void> {
  const { rows: [p] } = await c.query('INSERT INTO participant (entreprise_id, session_id, salarie_id) VALUES ($1, $2, $3) RETURNING id', [entreprise, session, salarieId])
  await c.query(`INSERT INTO attestation (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie, intitule_formation, nom_entreprise,
                   date_debut, date_fin, expire_le) VALUES ($1, $2, $3, 'Nom', 'Test', $4, 'Entreprise', CURRENT_DATE - 700, CURRENT_DATE - 699, CURRENT_DATE + $5::int)`,
  [entreprise, p.id, randomBytes(16).toString('base64url'), `SST ${suffixe}`, dansJours])
}
const lister = async (jeton: string, horizon = 90) =>
  (await json(await traiterListeOpportunites(req('GET', undefined, cookie(jeton), `${ORIGINE}/api/opportunites?horizon=${horizon}`)))).opportunites as Record<string, any>[]
const deB = (liste: Record<string, any>[]) => liste.filter((o) => o.entreprise_id === f.entrepriseB)

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.consultantC1, f.adminPlateformeP1, f.utilisateurA1]])
    rows.forEach((r) => emails.set(r.id, r.email))
    await c.query("UPDATE utilisateur SET telephone = '97 00 00 01' WHERE id = $1", [f.utilisateurB1])
    formation = (await c.query(`INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours, validite_mois) VALUES (NULL, $1, $2, 'securite', 2, 24) RETURNING id`,
      [`sst-opp-${suffixe}`, `SST ${suffixe}`])).rows[0].id
    sessionB = (await c.query(`INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin) VALUES ($1, $2, $3, CURRENT_DATE - 700, CURRENT_DATE - 699) RETURNING id`,
      [f.entrepriseB, formation, `OPP-B-${suffixe}`])).rows[0].id
    const sessionA = (await c.query(`INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin) VALUES ($1, $2, $3, CURRENT_DATE - 700, CURRENT_DATE - 699) RETURNING id`,
      [f.entrepriseA, formation, `OPP-A-${suffixe}`])).rows[0].id

    // B : 2 salariés à recycler (J+20, J+40) ; un 3e déjà recyclé (ancienne attestation J+10 remplacée par une J+500) ; un salarié sorti (J+5).
    await attestation(c, f.entrepriseB, sessionB, f.salarieB1, 20)
    await attestation(c, f.entrepriseB, sessionB, await salarie(c, f.entrepriseB, 'Deux'), 40)
    const recycle = await salarie(c, f.entrepriseB, 'Recyclé')
    await attestation(c, f.entrepriseB, sessionB, recycle, 10)
    const sessionRecyclage = (await c.query(`INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin) VALUES ($1, $2, $3, CURRENT_DATE - 30, CURRENT_DATE - 29) RETURNING id`,
      [f.entrepriseB, formation, `OPP-B2-${suffixe}`])).rows[0].id
    await attestation(c, f.entrepriseB, sessionRecyclage, recycle, 500)
    const sorti = await salarie(c, f.entrepriseB, 'Sorti')
    await c.query('UPDATE salarie SET date_sortie = CURRENT_DATE - 1 WHERE id = $1', [sorti])
    await attestation(c, f.entrepriseB, sessionB, sorti, 5)
    // A : une échéance, hors du périmètre du consultant (il n'a de mandat que sur B).
    await attestation(c, f.entrepriseA, sessionA, f.salarieA1, 15)

    typeHab = (await c.query("INSERT INTO type_habilitation (entreprise_id, code, intitule, domaine) VALUES ($1, $2, 'Habilitation électrique B1V', 'electrique') RETURNING id", [f.entrepriseB, `H-${suffixe}`])).rows[0].id
    await c.query('INSERT INTO habilitation (entreprise_id, salarie_id, type_id, date_delivrance, date_validite) VALUES ($1, $2, $3, CURRENT_DATE - 1100, CURRENT_DATE - 5)', [f.entrepriseB, f.salarieB1, typeHab])
    for (let i = 0; i < 2; i++) await c.query("INSERT INTO equipement (entreprise_id, type, designation, prochaine_verif) VALUES ($1, 'Extincteur', $2, CURRENT_DATE + 60)", [f.entrepriseB, `Extincteur ${i}`])
    await c.query("INSERT INTO equipement (entreprise_id, type, designation, prochaine_verif) VALUES ($1, 'Nacelle', 'Lointaine', CURRENT_DATE + 300)", [f.entrepriseB])
  })
})

afterAll(async () => {
  await migrate(async (c) => {
    await c.query("DELETE FROM notification WHERE module = 'opportunites' AND destinataire = ANY($1)", [[...emails.values()]])
    await c.query('DELETE FROM resume_opportunite_envoye WHERE utilisateur_id = ANY($1)', [[f.consultantC1, f.adminPlateformeP1]])
  })
  await nettoyerFixtures(f)
  await migrate((c) => c.query('DELETE FROM formation WHERE id = $1', [formation])).catch(() => {})
})

describe('Calcul et périmètre', () => {
  it('regroupe par entreprise et par objet, avec les mêmes critères que les alertes (attestation la plus récente, salarié présent)', async () => {
    const liste = deB(await lister(await session(f.consultantC1)))
    const recyclage = liste.find((o) => o.type === 'recyclage')!
    expect(recyclage).toMatchObject({ libelle: `SST ${suffixe}`, nb: 2, echues: 0, cle: formation, entreprise_nom: expect.stringContaining('Test Cloisonnement B') })
    const jours = (iso: string) => Math.round((new Date(`${iso}T00:00:00Z`).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000)
    expect(jours(recyclage.premiere_echeance)).toBe(20)
    expect(jours(recyclage.derniere_echeance)).toBe(40)
    expect(liste.find((o) => o.type === 'habilitation')).toMatchObject({ libelle: 'Habilitation électrique B1V', nb: 1, echues: 1 })
    expect(liste.find((o) => o.type === 'verification')).toMatchObject({ libelle: 'Extincteur', nb: 2, cle: 'extincteur' })
    // Contact : le responsable du client (admin d'entreprise) avec son téléphone.
    expect(recyclage).toMatchObject({ contact_telephone: '97 00 00 01', contact_email: emails.get(f.utilisateurB1) ?? expect.any(String) })
    // Horizon : la nacelle (J+300) n'apparaît qu'avec un horizon d'un an.
    expect(liste.some((o) => o.libelle === 'Nacelle')).toBe(false)
    expect(deB(await lister(await session(f.consultantC1), 365)).some((o) => o.libelle === 'Nacelle')).toBe(true)
  })

  it('le consultant ne voit que ses mandats en cours ; l’admin voit tous les clients', async () => {
    const consultant = await lister(await session(f.consultantC1))
    expect(consultant.some((o) => o.entreprise_id === f.entrepriseA)).toBe(false)
    const admin = await lister(await session(f.adminPlateformeP1))
    expect(admin.some((o) => o.entreprise_id === f.entrepriseA)).toBe(true)
    expect(admin.some((o) => o.entreprise_id === f.entrepriseB)).toBe(true)
    // Mandat expiré : plus rien.
    await migrate((c) => c.query('UPDATE acces_consultant SET fin_le = CURRENT_DATE - 1 WHERE utilisateur_id = $1 AND entreprise_id = $2', [f.consultantC1, f.entrepriseB]))
    expect(deB(await lister(await session(f.consultantC1)))).toEqual([])
    await migrate((c) => c.query('UPDATE acces_consultant SET fin_le = NULL WHERE utilisateur_id = $1 AND entreprise_id = $2', [f.consultantC1, f.entrepriseB]))
  })

  it('un client, ou sans session : refusé ; aucun accès direct aux tables ; horizon borné', async () => {
    const client = await session(f.utilisateurA1)
    expect((await traiterListeOpportunites(req('GET', undefined, cookie(client)))).status).toBe(403)
    expect((await traiterListeOpportunites(req('GET'))).status).toBe(401)
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => sql`select * from opportunites_vente()`.execute(trx))).rejects.toThrow(/Réservé/)
    await expect(withAuthenticatedUser(f.consultantC1, (trx) => sql`select * from opportunites_pour(${f.consultantC1}::uuid, 90)`.execute(trx))).rejects.toThrow(/permission denied/)
    await expect(withAuthenticatedUser(f.consultantC1, (trx) => sql`select * from suivi_opportunite`.execute(trx))).rejects.toThrow(/permission denied/)
    const r = await traiterListeOpportunites(req('GET', undefined, cookie(await session(f.consultantC1)), `${ORIGINE}/api/opportunites?horizon=5000`))
    expect(r.status).toBe(400)
  })
})

describe('Suivi', () => {
  it('« contacté » couvre les échéances connues ; une nouvelle échéance plus lointaine rouvre l’opportunité', async () => {
    const consultant = await session(f.consultantC1)
    const suivre = (corps: Record<string, unknown>, jeton = consultant) => traiterSuiviOpportunite(req('POST', corps, cookie(jeton)))
    const r = await suivre({ entrepriseId: f.entrepriseB, type: 'recyclage', cle: formation, statut: 'contacte', note: 'Appelé, devis à envoyer' })
    expect(r.status, await r.clone().text()).toBe(200)
    expect(deB(await lister(consultant)).find((o) => o.type === 'recyclage')).toMatchObject({ suivi_statut: 'contacte', suivi_note: 'Appelé, devis à envoyer', suivi_par: 'Utilisateur c1' })

    await migrate(async (c) => attestation(c, f.entrepriseB, sessionB, await salarie(c, f.entrepriseB, 'Trois'), 80))
    expect(deB(await lister(consultant)).find((o) => o.type === 'recyclage')).toMatchObject({ nb: 3, suivi_statut: null })

    // Hors périmètre, objet inconnu, statut inconnu, client.
    expect((await suivre({ entrepriseId: f.entrepriseA, type: 'recyclage', cle: formation, statut: 'contacte' })).status).toBe(404)
    expect((await suivre({ entrepriseId: f.entrepriseB, type: 'recyclage', cle: 'inconnue', statut: 'contacte' })).status).toBe(404)
    expect((await suivre({ entrepriseId: f.entrepriseB, type: 'recyclage', cle: formation, statut: 'vendu' })).status).toBe(409)
    expect((await suivre({ entrepriseId: f.entrepriseB, type: 'recyclage', cle: formation, statut: 'gagne' }, await session(f.utilisateurA1))).status).toBe(403)
    expect((await suivre({ entrepriseId: 'pas-un-uuid', type: 'recyclage', cle: formation, statut: 'gagne' })).status).toBe(400)
  })
})

describe('Résumé hebdomadaire', () => {
  it('met en file un e-mail par membre de l’équipe ayant des opportunités à relancer, une seule fois par semaine', async () => {
    const appeler = () => withAuthenticatedUser(f.consultantC1, (trx) => sql<{ n: number }>`select envoyer_resume_opportunites('https://plateforme.test') as n`.execute(trx))
    await appeler()
    await appeler()
    const { rows } = await migrate((c) => c.query("SELECT sujet, corps FROM notification WHERE module = 'opportunites' AND destinataire = $1", [emails.get(f.consultantC1)]))
    expect(rows).toHaveLength(1)
    expect(rows[0].sujet).toMatch(/opportunités? de vente à relancer/)
    expect(rows[0].corps).toContain('Habilitation électrique B1V')
    expect(rows[0].corps).toContain('https://plateforme.test/opportunites')
    expect(rows[0].corps).not.toContain('Test Cloisonnement A')
  })
})

describe('Messages prérédigés et liens WhatsApp', () => {
  it('message selon le type, au singulier ou au pluriel, échu ou non', () => {
    const base = { libelle: 'SST', nb: 3, premiere_echeance: '2026-12-12', echues: 0, entreprise_nom: 'BTP Lagune', contact_nom: 'Mme Dossou' }
    expect(messageRelance({ ...base, type: 'recyclage' })).toMatch(/^Bonjour Mme Dossou,[\s\S]*« SST » de 3 salariés de BTP Lagune arrivent à échéance à partir du 12 décembre 2026/)
    expect(messageRelance({ ...base, type: 'habilitation', nb: 1, echues: 1 })).toContain('de 1 salarié de BTP Lagune sont échues depuis le 12 décembre 2026')
    expect(messageRelance({ ...base, type: 'verification', libelle: 'Extincteur', contact_nom: null })).toMatch(/^Bonjour,[\s\S]*3 équipements « Extincteur »/)
  })

  it('numéros : indicatif du pays, numéro international conservé, 0 initial retiré pour la France seulement', () => {
    expect(numeroWhatsApp('01 97 12 34 56', 'BJ')).toBe('2290197123456')
    expect(numeroWhatsApp('+229 01 97 12 34 56', 'FR')).toBe('2290197123456')
    expect(numeroWhatsApp('0033 6 12 34 56 78', 'BJ')).toBe('33612345678')
    expect(numeroWhatsApp('06 12 34 56 78', 'FR')).toBe('33612345678')
    expect(numeroWhatsApp('07 07 00 00 00', 'CI')).toBe('2250707000000')
    expect(numeroWhatsApp('90 00 00 00', 'TG')).toBe('22890000000')
    expect(numeroWhatsApp('12', 'BJ')).toBeNull()
    expect(numeroWhatsApp('97 00 00 00', 'XX')).toBeNull()
    expect(lienWhatsApp('+22997000000', 'BJ', 'Bonjour & merci')).toBe('https://wa.me/22997000000?text=Bonjour%20%26%20merci')
  })
})
