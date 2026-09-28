import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accesConsultantValide, exigerAccesConsultant, listerAccesConsultantValides } from '@/auth/acces'
import { withAuthenticatedUser, withPlatformAdmin, withTenant } from '@/db/tenant'
import { creerProspect } from '@/inspections/prospect'
import { indicateursPlateforme, resumePlateforme } from '@/tableau-bord/plateforme'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

/**
 * Ce que exigerAccesConsultant vérifie — et donc ce que TOUTE route
 * d'inspection doit lui demander avant withTenant (cf.
 * src/app/api/inspections/LISEZ-MOI.md). La RLS ne connaît que
 * app.entreprise_id : sans cet appel côté serveur, ces règles n'existent pas.
 */

let f: Fixtures
let fi: FixturesInspections
const prospectsCrees: string[] = []

async function avecMigrate<T>(cb: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  try {
    return await cb(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  f = await creerFixtures()
  fi = await creerFixturesInspections(f)
})

afterAll(async () => {
  // Nettoyage des tests uniquement : en production un prospect abandonné se
  // DÉSACTIVE, il ne se supprime pas.
  await avecMigrate((c) => c.query('DELETE FROM entreprise WHERE id = ANY($1)', [prospectsCrees]))
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

describe('Accès consultant — ce que acces_consultant lui ouvre, et rien d’autre', () => {
  it('le consultant a un accès valide à B (accordé), avec écriture', async () => {
    const acces = await withAuthenticatedUser(f.consultantC1, (trx) =>
      accesConsultantValide(trx, { utilisateurId: f.consultantC1, entrepriseId: f.entrepriseB }),
    )
    expect(acces).toMatchObject({ entrepriseId: f.entrepriseB, ecriture: true })
  })

  it('…et lit les inspections de B une fois dans ce tenant, jamais celles de A', async () => {
    const ids = (
      await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.consultantC1 }, (trx) =>
        trx.selectFrom('inspection').select('id').execute(),
      )
    ).map((r) => r.id)
    expect(ids).toContain(fi.inspectionB)
    expect(ids).not.toContain(fi.inspectionA)
  })

  it('aucun accès à A : accès refusé (jamais accordé)', async () => {
    await expect(
      withAuthenticatedUser(f.consultantC1, (trx) =>
        exigerAccesConsultant(trx, { utilisateurId: f.consultantC1, entrepriseId: f.entrepriseA }),
      ),
    ).rejects.toThrow(/aucun accès consultant valide/)
  })

  it('un consultant sans aucun accès n’en obtient sur aucune entreprise', async () => {
    const acces = await withAuthenticatedUser(fi.consultantSansAcces, (trx) => listerAccesConsultantValides(trx, fi.consultantSansAcces))
    expect(acces).toEqual([])
  })

  it('un accès dont la date de fin est dépassée ne donne plus rien', async () => {
    const acces = await withAuthenticatedUser(fi.consultantExpire, (trx) =>
      accesConsultantValide(trx, { utilisateurId: fi.consultantExpire, entrepriseId: f.entrepriseA }),
    )
    expect(acces).toBeNull()
    const liste = await withAuthenticatedUser(fi.consultantExpire, (trx) => listerAccesConsultantValides(trx, fi.consultantExpire))
    expect(liste).toEqual([])
  })

  it('un accès en lecture seule autorise à entrer mais pas à écrire', async () => {
    const lecture = await withAuthenticatedUser(fi.consultantLecture, (trx) =>
      exigerAccesConsultant(trx, { utilisateurId: fi.consultantLecture, entrepriseId: f.entrepriseA }),
    )
    expect(lecture.ecriture).toBe(false)
    await expect(
      withAuthenticatedUser(fi.consultantLecture, (trx) =>
        exigerAccesConsultant(trx, { utilisateurId: fi.consultantLecture, entrepriseId: f.entrepriseA, ecriture: true }),
      ),
    ).rejects.toThrow(/lecture seule/)
  })

  it('un consultant ne voit pas les accès d’un AUTRE consultant', async () => {
    const vus = await withAuthenticatedUser(fi.consultantLecture, (trx) => trx.selectFrom('acces_consultant').select('utilisateur_id').execute())
    expect(vus.every((a) => a.utilisateur_id === fi.consultantLecture)).toBe(true)
  })
})

describe('Entreprise désactivée (migration 0010) — on désactive, on ne supprime pas', () => {
  let prospectId: string
  const admin = () => ({ utilisateurId: f.adminPlateformeP1 })

  const desactiver = (valeur: Date | null) =>
    withPlatformAdmin({ ...admin(), operation: 'modifier_entreprise', details: { desactive: valeur !== null } }, (trx) =>
      trx.updateTable('entreprise').set({ desactive_le: valeur }).where('id', '=', prospectId).executeTakeFirst(),
    )

  beforeAll(async () => {
    prospectId = await withAuthenticatedUser(f.consultantC1, (trx) =>
      creerProspect(trx, { nom: `Prospect désactivable ${fi.suffixe}`, pays: 'BJ' }),
    )
    prospectsCrees.push(prospectId)
    // Une donnée d'historique à conserver.
    await withTenant({ entrepriseId: prospectId, utilisateurId: f.consultantC1 }, (trx) =>
      trx.insertInto('site').values({ entreprise_id: prospectId, nom: 'Site à conserver' }).execute(),
    )
  })

  it('avant désactivation : accès valide et visible dans les indicateurs', async () => {
    const acces = await withAuthenticatedUser(f.consultantC1, (trx) =>
      accesConsultantValide(trx, { utilisateurId: f.consultantC1, entrepriseId: prospectId }),
    )
    expect(acces).not.toBeNull()
    const lignes = await withPlatformAdmin({ ...admin(), operation: 'consulter_indicateurs_plateforme' }, (trx) => indicateursPlateforme(trx))
    expect(lignes.some((l) => l.entreprise_id === prospectId)).toBe(true)
  })

  it("désactiver l'entreprise invalide l'accès consultant, même sans date de fin dépassée", async () => {
    const maj = await desactiver(new Date())
    expect(Number(maj.numUpdatedRows)).toBe(1)

    await expect(
      withAuthenticatedUser(f.consultantC1, (trx) =>
        exigerAccesConsultant(trx, { utilisateurId: f.consultantC1, entrepriseId: prospectId }),
      ),
    ).rejects.toThrow(/aucun accès consultant valide/)

    const liste = await withAuthenticatedUser(f.consultantC1, (trx) => listerAccesConsultantValides(trx, f.consultantC1))
    expect(liste.some((a) => a.entrepriseId === prospectId)).toBe(false)
    // …mais l'accès accordé à B (autre entreprise, active) est intact.
    expect(liste.some((a) => a.entrepriseId === f.entrepriseB)).toBe(true)
  })

  it('elle sort des indicateurs IFECARM, et est comptée à part', async () => {
    const lignes = await withPlatformAdmin({ ...admin(), operation: 'consulter_indicateurs_plateforme' }, (trx) => indicateursPlateforme(trx))
    expect(lignes.some((l) => l.entreprise_id === prospectId)).toBe(false)
    const resume = await withPlatformAdmin({ ...admin(), operation: 'consulter_indicateurs_plateforme' }, (trx) => resumePlateforme(trx))
    expect(resume.entreprises_desactivees).toBeGreaterThanOrEqual(1)
  })

  it("elle sort de ses propres vues de tableau de bord (plus de ligne pour ce tenant)", async () => {
    const rows = await withTenant({ entrepriseId: prospectId, utilisateurId: f.consultantC1 }, (trx) =>
      trx.selectFrom('v_indicateurs_inspections').select('entreprise_id').execute(),
    )
    expect(rows).toEqual([])
  })

  it('aucune donnée n’est supprimée : l’historique et le journal restent intacts', async () => {
    const lu = await avecMigrate(async (c) => ({
      sites: (await c.query('SELECT count(*)::int AS n FROM site WHERE entreprise_id = $1', [prospectId])).rows[0].n,
      journal: (await c.query("SELECT count(*)::int AS n FROM journal_audit WHERE action = 'creer_prospect' AND objet_id = $1", [prospectId])).rows[0].n,
      entreprise: (await c.query('SELECT desactive_le IS NOT NULL AS desactivee FROM entreprise WHERE id = $1', [prospectId])).rows[0],
    }))
    expect(lu).toEqual({ sites: 1, journal: 1, entreprise: { desactivee: true } })
  })

  it('réactiver l’entreprise rétablit l’accès (tant que la date de fin n’est pas dépassée)', async () => {
    await desactiver(null)
    const acces = await withAuthenticatedUser(f.consultantC1, (trx) =>
      accesConsultantValide(trx, { utilisateurId: f.consultantC1, entrepriseId: prospectId }),
    )
    expect(acces).not.toBeNull()
  })

  it('un utilisateur normal ne peut pas désactiver une entreprise (réservé à platform_admin)', async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx.updateTable('entreprise').set({ desactive_le: new Date() }).where('id', '=', f.entrepriseA).execute(),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})
