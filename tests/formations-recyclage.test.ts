import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant, withoutTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Migrations 0044 et 0046 : alertes de recyclage B2 (jalons 90/30/7 puis échéance, comme B3 et B4). Fonction exécutée avec ifecarm_app
 * (withoutTenant) et limitée à une entreprise de test ; lectures de contrôle via ifecarm_migrate.
 */

let f: Fixtures
let ff: FixturesFormations
let qhse: string
let respSite: string
let siteX: string
let session2: string
const att: Record<string, string> = {}

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const alerter = (entreprise: string) => withoutTenant(async (trx) => Number((await sql<{ n: number }>`select alerter_recyclages(${entreprise}::uuid) as n`.execute(trx)).rows[0]!.n))
const jalons = () => migrate(async (c) => Object.fromEntries((await c.query(
  `SELECT a.intitule_formation AS l, al.jalon_jours FROM alerte_recyclage al JOIN attestation a ON a.id = al.attestation_id WHERE al.entreprise_id = $1 AND a.intitule_formation LIKE 'RC-%'`, [f.entrepriseA])).rows.map((r) => [r.l, r.jalon_jours])))

async function utilisateur(c: Client, label: string, role: string, site?: string): Promise<string> {
  const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseA, `${label}-${randomUUID().slice(0, 8)}@test.local`, label])
  await c.query('INSERT INTO role_utilisateur (utilisateur_id, role, site_id) VALUES ($1, $2, $3)', [u.id, role, site ?? null])
  return u.id
}

/** Un salarié, son inscription à la session indiquée, et une attestation « RC-… » arrivant à échéance dans `jours` jours. */
async function attestation(c: Client, nom: string, jours: number | null, opts: { session?: string, siteId?: string, statut?: string, sortie?: boolean, salarie?: string } = {}) {
  const salarie = opts.salarie ?? (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom, site_id, date_sortie) VALUES ($1, $2, 'Test', $3, $4) RETURNING id",
    [f.entrepriseA, nom, opts.siteId ?? null, opts.sortie ? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) : null])).rows[0].id
  const participant = (await c.query('INSERT INTO participant (entreprise_id, session_id, salarie_id) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseA, opts.session ?? ff.sessionA, salarie])).rows[0].id
  const id = (await c.query(
    `INSERT INTO attestation (entreprise_id, participant_id, code_verification, nom_salarie, prenom_salarie, intitule_formation, nom_entreprise, date_debut, date_fin, expire_le, statut, motif_annulation, annulee_le)
     VALUES ($1, $2, $3, $4, 'Test', $5, 'Test A', CURRENT_DATE - 300, CURRENT_DATE - 299, ${jours === null ? 'NULL' : `CURRENT_DATE + (${jours})`}, $6, $7, ${opts.statut === 'annulee' ? 'now()' : 'NULL'}) RETURNING id`,
    [f.entrepriseA, participant, randomBytes(12).toString('base64url'), nom, `RC-${nom}`, opts.statut ?? 'valide', opts.statut === 'annulee' ? 'test' : null])).rows[0].id
  return { id: id as string, salarie: salarie as string }
}

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
  await migrate(async (c) => {
    siteX = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site recyclage') RETURNING id", [f.entrepriseA])).rows[0].id
    qhse = await utilisateur(c, 'qhse', 'responsable_qhse')
    respSite = await utilisateur(c, 'respsite', 'responsable_site', siteX)
    const formation = (await c.query('SELECT formation_id FROM session_formation WHERE id = $1', [ff.sessionA])).rows[0].formation_id
    session2 = (await c.query("INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 1) RETURNING id", [f.entrepriseA, formation, `RC-S2-${randomUUID().slice(0, 6)}`])).rows[0].id
    att.lointaine = (await attestation(c, 'lointaine', 100)).id
    att.j90 = (await attestation(c, 'j90', 60)).id
    att.j30 = (await attestation(c, 'j30', 20, { siteId: siteX })).id
    att.j7 = (await attestation(c, 'j7', 5)).id
    att.echue = (await attestation(c, 'echue', -3)).id
    att.aujourdhui = (await attestation(c, 'aujourdhui', 0)).id
    att.sansEcheance = (await attestation(c, 'sans-echeance', null)).id
    att.annulee = (await attestation(c, 'annulee', 10, { statut: 'annulee' })).id
    att.sortie = (await attestation(c, 'sortie', 10, { sortie: true })).id
    // Renouvelée : la même personne a une autre attestation valide de la MÊME formation, plus lointaine.
    const ancien = await attestation(c, 'renouvelee', 10)
    att.renouvelee = ancien.id
    await attestation(c, 'renouvelee', 400, { session: session2, salarie: ancien.salarie })
    // Autre formation, même personne : ne compte pas comme un renouvellement.
    const autreFormation = (await c.query("INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours) VALUES ($1, $2, 'Autre formation', 'test', 1) RETURNING id", [f.entrepriseA, `autre-${randomUUID().slice(0, 6)}`])).rows[0].id
    const session3 = (await c.query("INSERT INTO session_formation (entreprise_id, formation_id, reference, date_debut, date_fin) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 1) RETURNING id", [f.entrepriseA, autreFormation, `RC-S3-${randomUUID().slice(0, 6)}`])).rows[0].id
    const p = await attestation(c, 'autre-formation', 10)
    await attestation(c, 'autre-formation-bis', 400, { session: session3, salarie: p.salarie })
    att.autreFormation = p.id
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Alertes de recyclage (B2)', () => {
  it('un jalon par attestation, le plus avancé (90, 30, 7, échéance) ; rien pour le lointain, sans échéance, annulé, sorti ou déjà renouvelé', async () => {
    const n = await alerter(f.entrepriseA)
    const j = await jalons()
    expect(j).toMatchObject({ 'RC-j90': 90, 'RC-j30': 30, 'RC-j7': 7, 'RC-echue': 0, 'RC-aujourdhui': 0, 'RC-autre-formation': 30 })
    expect(Object.keys(j)).not.toEqual(expect.arrayContaining(['RC-lointaine', 'RC-sans-echeance', 'RC-annulee', 'RC-sortie', 'RC-renouvelee']))
    expect(n).toBe(6) // j90, j30, j7, échue, échéance aujourd'hui, autre formation (l'attestation « bis » est lointaine : aucune alerte)
  })

  it('contrainte de la table : jalons 90, 30, 7 et 0 seulement', async () => {
    await expect(migrate((c) => c.query('INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 15)', [f.entrepriseA, att.lointaine]))).rejects.toThrow(/check/i)
  })

  it('idempotent, puis escalade au jalon suivant', async () => {
    expect(await alerter(f.entrepriseA)).toBe(0)
    // L'échéance d'une attestation est figée (trigger 0029) : on avance le temps en remplaçant l'alerte par une plus ancienne.
    await migrate((c) => c.query("DELETE FROM alerte_recyclage WHERE attestation_id = $1", [att.j7]))
    await migrate((c) => c.query("INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 30)", [f.entrepriseA, att.j7]))
    expect(await alerter(f.entrepriseA)).toBe(1) // le jalon 7 se déclenche à son tour, une seule fois
    expect(await alerter(f.entrepriseA)).toBe(0)
    // Un jalon 7 déjà signalé, puis l'échéance arrive : dernière alerte (jalon 0), une seule fois.
    await migrate((c) => c.query('DELETE FROM alerte_recyclage WHERE attestation_id = $1', [att.echue]))
    await migrate((c) => c.query('INSERT INTO alerte_recyclage (entreprise_id, attestation_id, jalon_jours) VALUES ($1, $2, 7)', [f.entrepriseA, att.echue]))
    expect(await alerter(f.entrepriseA)).toBe(1)
    expect(await alerter(f.entrepriseA)).toBe(0)
  })

  it('destinataires : admin d’entreprise, responsable QHSE, responsable du site du salarié ; contenu neutre ; échue = message dédié', async () => {
    const mails = await migrate(async (c) => (await c.query(
      "SELECT destinataire, sujet, corps, module FROM notification WHERE entreprise_id = $1 AND module = 'formations' AND corps LIKE '%RC-%' OR (entreprise_id = $1 AND module = 'formations' AND corps LIKE '%Formation%')", [f.entrepriseA])).rows)
    const emails = await migrate(async (c) => Object.fromEntries((await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, qhse, respSite]])).rows.map((r) => [r.id, r.email])))
    const duJ30 = mails.filter((m) => m.corps.includes('RC-j30')).map((m) => m.destinataire)
    expect(duJ30).toEqual(expect.arrayContaining([emails[f.utilisateurA1], emails[qhse], emails[respSite]])) // salarié du site : son responsable est prévenu
    expect(new Set(duJ30).size).toBe(duJ30.length)
    const duJ7 = mails.filter((m) => m.corps.includes('RC-j7')).map((m) => m.destinataire)
    expect(duJ7).not.toContain(emails[respSite]) // salarié sans site : pas de responsable de site
    const echue = mails.find((m) => m.corps.includes('RC-echue'))!
    expect(echue.sujet).toMatch(/^Attestation échue — Test echue/)
    expect(echue.corps).toMatch(/est échue depuis le/)
    expect(mails.find((m) => m.corps.includes('RC-aujourdhui'))!.corps).toMatch(/arrive à échéance aujourd'hui/)
    expect(mails.find((m) => m.corps.includes('RC-j90'))!.sujet).toMatch(/^Recyclage à prévoir — Test j90/)
  })

  it('cloisonnement : un client lit les alertes de son entreprise, jamais celles d’une autre ; l’autre entreprise n’est pas alertée', async () => {
    const vuesA = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => trx.selectFrom('alerte_recyclage').select('entreprise_id').execute())
    expect(vuesA.length).toBeGreaterThan(5)
    expect(vuesA.every((r) => r.entreprise_id === f.entrepriseA)).toBe(true)
    const vuesB = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => trx.selectFrom('alerte_recyclage').select('attestation_id').execute())
    expect(vuesB.map((r) => r.attestation_id)).not.toContain(att.j30)
    expect(await alerter(f.entrepriseB)).toBe(0)
    // Le client n'écrit jamais dans les alertes.
    await expect(withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => trx.insertInto('alerte_recyclage').values({ entreprise_id: f.entrepriseA, attestation_id: att.lointaine!, jalon_jours: 90 }).execute())).rejects.toThrow(/row-level security/)
  })

  it('entreprise désactivée : aucune alerte', async () => {
    await migrate((c) => c.query('DELETE FROM alerte_recyclage WHERE entreprise_id = $1', [f.entrepriseA]))
    await migrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseA]))
    expect(await alerter(f.entrepriseA)).toBe(0)
  })
})
