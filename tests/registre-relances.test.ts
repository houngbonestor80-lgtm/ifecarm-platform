import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant, withoutTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Migration 0041 : relances des actions en retard. La fonction est exécutée avec ifecarm_app
 * (withoutTenant), limitée à une entreprise de test (p_entreprise) pour ne pas toucher aux données de
 * développement. Les lectures de contrôle passent par ifecarm_migrate.
 */

let f: Fixtures
let responsableId: string
const actions: Record<string, string> = {}

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const relancer = (entreprise: string) => withoutTenant(async (trx) => Number((await sql<{ n: number }>`select relancer_actions_en_retard(${entreprise}::uuid) as n`.execute(trx)).rows[0]!.n))
const jalons = () => migrate(async (c) => Object.fromEntries((await c.query(
  'SELECT a.libelle, r.jalon FROM relance_action r JOIN action_corrective a ON a.id = r.action_id WHERE r.entreprise_id = $1', [f.entrepriseA])).rows.map((r) => [r.libelle, r.jalon])))

async function creerAction(c: Client, entreprise: string, libelle: string, decalageJours: number | null, extra: { statut?: string, responsable?: string } = {}) {
  const r = await c.query(
    `INSERT INTO action_corrective (entreprise_id, reference, origine_type, libelle, echeance, statut, responsable_id, realisee_le)
     VALUES ($1, $2, 'autre', $3, ${decalageJours === null ? 'NULL' : `current_date + (${decalageJours})`}, $4, $5, ${extra.statut === 'realisee' ? 'current_date' : 'NULL'}) RETURNING id`,
    [entreprise, `PA-T-${randomUUID().slice(0, 8)}`, libelle, extra.statut ?? 'a_faire', extra.responsable ?? null])
  return r.rows[0].id as string
}

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    responsableId = (await c.query("INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, 'Responsable action') RETURNING id", [f.entrepriseA, `resp-${randomUUID().slice(0, 8)}@test.local`])).rows[0].id
    actions.dansCinqJours = await creerAction(c, f.entrepriseA, 'dans 5 jours', 5)
    actions.dansVingtJours = await creerAction(c, f.entrepriseA, 'dans 20 jours', 20)
    actions.retard3 = await creerAction(c, f.entrepriseA, 'retard 3 jours', -3, { responsable: responsableId })
    actions.retard10 = await creerAction(c, f.entrepriseA, 'retard 10 jours', -10)
    actions.retard45 = await creerAction(c, f.entrepriseA, 'retard 45 jours', -45)
    actions.realisee = await creerAction(c, f.entrepriseA, 'réalisée en retard', -20, { statut: 'realisee' })
    actions.sansEcheance = await creerAction(c, f.entrepriseA, 'sans échéance', null)
    actions.chezB = await creerAction(c, f.entrepriseB, 'retard chez B', -4)
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('Relances des actions en retard', () => {
  it('une relance par action, au jalon le plus avancé atteint ; rien pour le reste', async () => {
    expect(await relancer(f.entrepriseA)).toBe(4)
    expect(await jalons()).toEqual({ 'dans 5 jours': 'j_moins_7', 'retard 3 jours': 'echeance', 'retard 10 jours': 'j_plus_7', 'retard 45 jours': 'j_plus_30' })
    // Pas de rafale : l'action en retard de 45 jours n'a reçu qu'une relance, pas quatre.
    const n = await migrate(async (c) => Number((await c.query('SELECT count(*) FROM relance_action WHERE action_id = $1', [actions.retard45])).rows[0].count))
    expect(n).toBe(1)
  })

  it('idempotent : un second passage le même jour ne renvoie rien', async () => {
    expect(await relancer(f.entrepriseA)).toBe(0)
  })

  it('escalade : le jalon suivant déclenche une nouvelle relance, une seule', async () => {
    await migrate((c) => c.query('UPDATE action_corrective SET echeance = current_date - 8 WHERE id = $1', [actions.retard3]))
    expect(await relancer(f.entrepriseA)).toBe(1)
    const lignes = await migrate(async (c) => (await c.query('SELECT jalon FROM relance_action WHERE action_id = $1 ORDER BY declenchee_le, jalon', [actions.retard3])).rows.map((r) => r.jalon))
    expect(lignes.sort()).toEqual(['echeance', 'j_plus_7'])
    expect(await relancer(f.entrepriseA)).toBe(0)
  })

  it('destinataires : le responsable de l’action et les responsables de l’entreprise, sans doublon ; jamais une autre entreprise', async () => {
    const { destinataires, moduleNotif, sujet, corps } = await migrate(async (c) => {
      const r = await c.query(
        `SELECT n.destinataire, n.module, n.sujet, n.corps FROM relance_action ra JOIN notification n ON n.id = ra.notification_id
         WHERE ra.action_id = $1 AND ra.jalon = 'echeance'`, [actions.retard3])
      // Tous les destinataires du jalon : toutes les notifications de l'entreprise pour cette action.
      const tous = await c.query("SELECT destinataire FROM notification WHERE entreprise_id = $1 AND sujet = $2 AND corps LIKE '%retard de 3 jour%' ORDER BY destinataire", [f.entrepriseA, r.rows[0].sujet])
      return { destinataires: tous.rows.map((x) => x.destinataire as string), moduleNotif: r.rows[0].module, sujet: r.rows[0].sujet, corps: r.rows[0].corps }
    })
    expect(new Set(destinataires).size).toBe(destinataires.length)
    expect(destinataires.length).toBeGreaterThanOrEqual(2) // responsable de l'action + admin_entreprise A1
    expect(destinataires.every((d) => d.endsWith('@test.local'))).toBe(true)
    expect(moduleNotif).toBe('actions')
    expect(sujet).toMatch(/^Action en retard — PA-T-/)
    expect(corps).toMatch(/retard 3 jours/)
    const chezB = await migrate(async (c) => Number((await c.query("SELECT count(*) FROM notification WHERE entreprise_id = $1", [f.entrepriseB])).rows[0].count))
    expect(chezB).toBe(0) // B n'a pas été relancée : la fonction était limitée à A
  })

  it('une autre entreprise est relancée séparément, et ses relances restent illisibles pour A', async () => {
    expect(await relancer(f.entrepriseB)).toBe(1)
    const vuParB = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => trx.selectFrom('relance_action').select('action_id').execute())
    expect(vuParB.map((r) => r.action_id)).toEqual([actions.chezB])
    // Un utilisateur du client (admin d'entreprise A1) lit les relances de A, mais pas celles de B.
    const vuParA = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) => trx.selectFrom('relance_action').select('action_id').execute())
    expect(vuParA.map((r) => r.action_id)).not.toContain(actions.chezB)
    expect(vuParA.length).toBeGreaterThanOrEqual(5)
  })

  it('entreprise désactivée : plus de relance', async () => {
    await migrate(async (c) => {
      await c.query("UPDATE action_corrective SET echeance = current_date - 40 WHERE id = $1", [actions.chezB])
      await c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseB])
    })
    expect(await relancer(f.entrepriseB)).toBe(0)
  })
})
