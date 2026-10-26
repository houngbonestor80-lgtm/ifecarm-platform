import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

/**
 * Migration 0042 : notes internes sur les objets (inspection, non-conformité, action, session, équipement,
 * déclaration). Internes à l'équipe IFECARM, auteur posé par le serveur, immuables, objet de la même
 * entreprise, supprimées avec leur objet. Toutes les assertions passent par ifecarm_app (withTenant).
 */

let f: Fixtures
let fi: FixturesInspections
let ff: FixturesFormations
let declarationA: string
let declarationB: string
let consultant2: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const A = (utilisateurId: string) => ({ entrepriseId: f.entrepriseA, utilisateurId })
const noter = (u: string, objetType: string, objetId: string, contenu = 'Note interne', entreprise = f.entrepriseA) =>
  withTenant({ entrepriseId: entreprise, utilisateurId: u }, (trx) => trx.insertInto('note_objet')
    .values({ entreprise_id: entreprise, objet_type: objetType, objet_id: objetId, contenu, auteur_nom: 'ignoré', auteur_id: f.utilisateurA1 }).returning('id').executeTakeFirstOrThrow())
const lire = (u: string, entreprise = f.entrepriseA) =>
  withTenant({ entrepriseId: entreprise, utilisateurId: u }, (trx) => trx.selectFrom('note_objet').select(['id', 'objet_type', 'auteur_id', 'auteur_nom', 'contenu']).execute())

beforeAll(async () => {
  f = await creerFixtures()
  fi = await creerFixturesInspections(f)
  ff = await creerFixturesFormations(f)
  await migrate(async (c) => {
    declarationA = (await c.query("INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description) VALUES ($1, $2, 'presqu_accident', now(), 'A') RETURNING id", [f.entrepriseA, `NOTE-A-${randomUUID().slice(0, 6)}`])).rows[0].id
    declarationB = (await c.query("INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description) VALUES ($1, $2, 'presqu_accident', now(), 'B') RETURNING id", [f.entrepriseB, `NOTE-B-${randomUUID().slice(0, 6)}`])).rows[0].id
    consultant2 = (await c.query("INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, 'Second consultant') RETURNING id", [f.ifecarmInterne, `c2-${randomUUID().slice(0, 8)}@test.local`])).rows[0].id
    await c.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'consultant_ifecarm')", [consultant2])
  })
})

afterAll(async () => {
  try { await migrate((c) => c.query('DELETE FROM utilisateur WHERE id = $1', [consultant2])) } catch { /* idem */ }
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
  try { await nettoyerFixturesInspections(fi) } catch { /* idem */ }
})

describe('Notes internes sur les objets', () => {
  it('l’équipe note chaque type d’objet ; auteur et nom sont posés par le serveur, jamais par l’appelant', async () => {
    const objets: [string, string][] = [
      ['inspection', fi.inspectionA], ['non_conformite', fi.ncA], ['action_corrective', fi.actionA],
      ['session_formation', ff.sessionA], ['equipement', fi.equipementA], ['declaration', declarationA],
    ]
    for (const [type, id] of objets) await noter(f.consultantC1, type, id, `Note ${type}`)
    const vues = await lire(f.consultantC1)
    expect(vues.map((n) => n.objet_type).sort()).toEqual(objets.map(([t]) => t).sort())
    expect(vues.every((n) => n.auteur_id === f.consultantC1)).toBe(true) // l'auteur_id usurpé (A1) est ignoré
    expect(vues.every((n) => n.auteur_nom !== 'ignoré')).toBe(true)
  })

  it('le client (admin d’entreprise comme simple utilisateur) ne lit, n’écrit ni ne supprime jamais une note', async () => {
    expect((await lire(f.utilisateurA1)).length).toBe(0)
    await expect(noter(f.utilisateurA1, 'declaration', declarationA)).rejects.toThrow(/row-level security/)
    const notes = await lire(f.consultantC1)
    const suppression = await withTenant(A(f.utilisateurA1), (trx) => trx.deleteFrom('note_objet').where('id', '=', notes[0]!.id).executeTakeFirst())
    expect(Number(suppression.numDeletedRows)).toBe(0)
  })

  it('un objet d’une autre entreprise, ou inexistant, ou un type inconnu : refusé', async () => {
    await expect(noter(f.consultantC1, 'declaration', declarationB)).rejects.toThrow(/n'existe pas dans cette entreprise/)
    await expect(noter(f.consultantC1, 'declaration', randomUUID())).rejects.toThrow(/n'existe pas dans cette entreprise/)
    await expect(noter(f.consultantC1, 'entreprise', declarationA)).rejects.toThrow(/check|n'existe pas/i)
    await expect(noter(f.consultantC1, 'declaration', declarationA, '   ')).rejects.toThrow(/check/i)
  })

  it('cloisonnement : les notes de A sont invisibles dans le tenant B, même pour un consultant', async () => {
    expect((await lire(f.consultantC1, f.entrepriseB)).length).toBe(0)
  })

  it('immuable (pas de modification) ; suppression par l’auteur ou l’administrateur, pas par un autre consultant', async () => {
    const { id } = await noter(f.consultantC1, 'declaration', declarationA, 'À supprimer')
    await expect(withTenant(A(f.consultantC1), (trx) => trx.updateTable('note_objet').set({ contenu: 'réécrit' }).where('id', '=', id).execute())).rejects.toThrow(/permission denied/)
    const autre = await withTenant(A(consultant2), (trx) => trx.deleteFrom('note_objet').where('id', '=', id).executeTakeFirst())
    expect(Number(autre.numDeletedRows)).toBe(0)
    const admin = await withTenant(A(f.adminPlateformeP1), (trx) => trx.deleteFrom('note_objet').where('id', '=', id).executeTakeFirst())
    expect(Number(admin.numDeletedRows)).toBe(1)
    const { id: id2 } = await noter(f.consultantC1, 'declaration', declarationA, 'Mienne')
    const auteur = await withTenant(A(f.consultantC1), (trx) => trx.deleteFrom('note_objet').where('id', '=', id2).executeTakeFirst())
    expect(Number(auteur.numDeletedRows)).toBe(1)
  })

  it('les notes disparaissent avec leur objet', async () => {
    await noter(f.consultantC1, 'declaration', declarationA, 'Liée')
    await migrate((c) => c.query('DELETE FROM declaration WHERE id = $1', [declarationA]))
    const restantes = await migrate(async (c) => Number((await c.query("SELECT count(*) FROM note_objet WHERE objet_type = 'declaration' AND objet_id = $1", [declarationA])).rows[0].count))
    expect(restantes).toBe(0)
  })
})
