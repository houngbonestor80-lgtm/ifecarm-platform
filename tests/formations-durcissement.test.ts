import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Migration 0029 : écriture B2 réservée à l'équipe IFECARM au niveau RLS,
 * même entreprise de bout en bout, attestation figée. Toutes les assertions
 * passent par ifecarm_app (withTenant) ; ifecarm_migrate ne sert qu'à préparer.
 */

let f: Fixtures
let ff: FixturesFormations
let siteB: string

const tenant = (entrepriseId: string, utilisateurId: string) => ({ entrepriseId, utilisateurId })
const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const nb = (r: { numUpdatedRows?: bigint, numDeletedRows?: bigint }) => Number(r.numUpdatedRows ?? r.numDeletedRows ?? 0)

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
  siteB = await migrate(async (c) => (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site B') RETURNING id", [f.entrepriseB])).rows[0].id)
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Écriture réservée à l’équipe IFECARM (client = consultation seule)', () => {
  const A = () => tenant(f.entrepriseA, f.utilisateurA1)   // utilisateur client de A
  const C = () => tenant(f.entrepriseA, f.consultantC1)    // consultant, dans le tenant A

  it('le client lit ses sessions, participants, émargements et attestations', async () => {
    const lu = await withTenant(A(), async (trx) => ({
      s: await trx.selectFrom('session_formation').select('id').execute(),
      p: await trx.selectFrom('participant').select('id').execute(),
      e: await trx.selectFrom('emargement').select('id').execute(),
      a: await trx.selectFrom('attestation').select('id').execute(),
    }))
    expect(lu.s.map((r) => r.id)).toEqual([ff.sessionA])
    expect(lu.p.map((r) => r.id)).toEqual([ff.participantA])
    expect(lu.e).toHaveLength(1)
    expect(lu.a.map((r) => r.id)).toEqual([ff.attestationA])
  })

  it('le client ne peut rien écrire : insertions refusées, modifications et suppressions sans effet', async () => {
    await expect(withTenant(A(), (trx) => trx.insertInto('session_formation')
      .values({ entreprise_id: f.entrepriseA, formation_id: ff.formationA, reference: 'CLIENT', date_debut: '2027-01-01', date_fin: '2027-01-01' }).execute()))
      .rejects.toThrow(/row-level security/)
    await expect(withTenant(A(), (trx) => trx.insertInto('participant')
      .values({ entreprise_id: f.entrepriseA, session_id: ff.sessionA, salarie_id: f.salarieA1 }).execute()))
      .rejects.toThrow()
    await expect(withTenant(A(), (trx) => sql`insert into alerte_recyclage (entreprise_id, attestation_id, jalon_jours) values (${f.entrepriseA}, ${ff.attestationA}, 90)`.execute(trx)))
      .rejects.toThrow(/row-level security/)

    const r = await withTenant(A(), async (trx) => ({
      s: await trx.updateTable('session_formation').set({ lieu: 'piraté' }).where('id', '=', ff.sessionA).executeTakeFirst(),
      p: await trx.updateTable('participant').set({ resultat: 'apte' }).where('id', '=', ff.participantA).executeTakeFirst(),
      e: await trx.updateTable('emargement').set({ present: false }).where('participant_id', '=', ff.participantA).executeTakeFirst(),
      a: await trx.updateTable('attestation').set({ statut: 'annulee' }).where('id', '=', ff.attestationA).executeTakeFirst(),
      f: await trx.updateTable('formation').set({ intitule: 'piraté' }).where('id', '=', ff.formationA).executeTakeFirst(),
      d: await trx.deleteFrom('participant').where('id', '=', ff.participantA).executeTakeFirst(),
    }))
    expect([nb(r.s), nb(r.p), nb(r.e), nb(r.a), nb(r.f), nb(r.d)]).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('le consultant écrit dans le tenant courant, jamais dans un autre', async () => {
    const id = await withTenant(C(), async (trx) => (await trx.insertInto('session_formation')
      .values({ entreprise_id: f.entrepriseA, formation_id: ff.formationCatalogue, reference: `C-${Date.now()}`, date_debut: '2027-01-01', date_fin: '2027-01-02' })
      .returning('id').executeTakeFirstOrThrow()).id)
    const maj = await withTenant(C(), (trx) => trx.updateTable('session_formation').set({ lieu: 'Cotonou' }).where('id', '=', id).executeTakeFirst())
    expect(nb(maj)).toBe(1)
    await expect(withTenant(C(), (trx) => trx.insertInto('session_formation')
      .values({ entreprise_id: f.entrepriseB, formation_id: ff.formationCatalogue, reference: 'AUTRE-TENANT', date_debut: '2027-01-01', date_fin: '2027-01-01' }).execute()))
      .rejects.toThrow(/row-level security/)
  })
})

describe('Même entreprise de bout en bout', () => {
  const C = () => tenant(f.entrepriseA, f.consultantC1)
  const session = (extra: Record<string, unknown>) => withTenant(C(), (trx) => trx.insertInto('session_formation')
    .values({ entreprise_id: f.entrepriseA, reference: `X-${Math.random().toString(36).slice(2, 8)}`, date_debut: '2027-02-01', date_fin: '2027-02-01', formation_id: ff.formationA, ...extra } as never).execute())

  it('une session ne peut pas viser la formation ou le site d’une autre entreprise', async () => {
    await expect(session({ formation_id: ff.formationB })).rejects.toThrow(/catalogue IFECARM ou à la même entreprise/)
    await expect(session({ site_id: siteB })).rejects.toThrow(/site doit appartenir/)
    await expect(session({ formation_id: ff.formationCatalogue })).resolves.toBeDefined()   // catalogue : autorisé
  })

  it('un participant ne peut pas relier une session ou un salarié d’une autre entreprise', async () => {
    await expect(withTenant(C(), (trx) => trx.insertInto('participant')
      .values({ entreprise_id: f.entrepriseA, session_id: ff.sessionB, salarie_id: f.salarieA1 }).execute())).rejects.toThrow(/foreign key|violates/)
    await expect(withTenant(C(), (trx) => trx.insertInto('participant')
      .values({ entreprise_id: f.entrepriseA, session_id: ff.sessionA, salarie_id: f.salarieB1 }).execute())).rejects.toThrow(/foreign key|violates/)
  })

  it('le slug du catalogue IFECARM est unique', async () => {
    const slug = await migrate(async (c) => (await c.query('SELECT slug FROM formation WHERE id = $1', [ff.formationCatalogue])).rows[0].slug)
    await expect(migrate((c) => c.query(
      "INSERT INTO formation (entreprise_id, slug, intitule, domaine, duree_jours) VALUES (NULL, $1, 'Doublon', 'x', 1)", [slug]))).rejects.toThrow(/uq_formation_catalogue_slug/)
  })
})

describe('Attestation figée', () => {
  const C = () => tenant(f.entrepriseA, f.consultantC1)

  it('les colonnes figées ne bougent pas, même pour le consultant ; l’annulation est irréversible', async () => {
    await expect(withTenant(C(), (trx) => trx.updateTable('attestation').set({ nom_salarie: 'Falsifié' }).where('id', '=', ff.attestationA).execute()))
      .rejects.toThrow(/figée/)
    await expect(withTenant(C(), (trx) => trx.updateTable('attestation').set({ expire_le: '2099-01-01' }).where('id', '=', ff.attestationA).execute()))
      .rejects.toThrow(/figée/)
    await expect(migrate((c) => c.query("UPDATE attestation SET code_verification = 'autre' WHERE id = $1", [ff.attestationA]))).rejects.toThrow(/figée/)

    const annulee = await withTenant(C(), (trx) => trx.updateTable('attestation')
      .set({ statut: 'annulee', motif_annulation: 'Erreur de saisie', annulee_le: new Date() }).where('id', '=', ff.attestationA).executeTakeFirst())
    expect(nb(annulee)).toBe(1)
    await expect(withTenant(C(), (trx) => trx.updateTable('attestation').set({ statut: 'valide' }).where('id', '=', ff.attestationA).execute()))
      .rejects.toThrow(/ne peut pas redevenir valide/)
  })
})

describe('salarie : écriture réservée à l’équipe IFECARM (migration 0032)', () => {
  const A = () => tenant(f.entrepriseA, f.utilisateurA1)   // utilisateur client de A
  const C = () => tenant(f.entrepriseA, f.consultantC1)    // consultant, dans le tenant A

  it('le client lit ses salariés mais ne peut ni en créer, ni modifier, ni supprimer', async () => {
    const lus = await withTenant(A(), (trx) => trx.selectFrom('salarie').select(['id', 'entreprise_id']).execute())
    expect(lus.map((s) => s.id)).toContain(f.salarieA1)
    expect(lus.every((s) => s.entreprise_id === f.entrepriseA)).toBe(true)

    await expect(withTenant(A(), (trx) => trx.insertInto('salarie').values({ entreprise_id: f.entrepriseA, nom: 'Client', prenom: 'Intrus' }).execute()))
      .rejects.toThrow(/row-level security/)
    const maj = await withTenant(A(), (trx) => trx.updateTable('salarie').set({ poste: 'Piraté' }).where('id', '=', f.salarieA1).executeTakeFirst())
    expect(nb(maj)).toBe(0)
    await expect(withTenant(A(), (trx) => trx.deleteFrom('salarie').where('id', '=', f.salarieA1).execute())).rejects.toThrow(/permission denied/)
    const poste = await migrate(async (c) => (await c.query('SELECT poste FROM salarie WHERE id = $1', [f.salarieA1])).rows[0].poste)
    expect(poste).not.toBe('Piraté')
  })

  it('le consultant crée et modifie dans le tenant courant, jamais dans un autre', async () => {
    const id = await withTenant(C(), async (trx) => (await trx.insertInto('salarie').values({ entreprise_id: f.entrepriseA, nom: 'Nouveau', prenom: 'Salarié' }).returning('id').executeTakeFirstOrThrow()).id)
    const maj = await withTenant(C(), (trx) => trx.updateTable('salarie').set({ poste: 'Soudeur' }).where('id', '=', id).executeTakeFirst())
    expect(nb(maj)).toBe(1)
    await expect(withTenant(C(), (trx) => trx.insertInto('salarie').values({ entreprise_id: f.entrepriseB, nom: 'Autre', prenom: 'Tenant' }).execute()))
      .rejects.toThrow(/row-level security/)
    const autre = await withTenant(C(), (trx) => trx.updateTable('salarie').set({ poste: 'Piraté' }).where('id', '=', f.salarieB1).executeTakeFirst())
    expect(nb(autre)).toBe(0)
  })
})
