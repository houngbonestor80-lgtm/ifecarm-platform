import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accesConsultantValide, exigerAccesConsultant } from '@/auth/acces'
import { withAuthenticatedUser, withPlatformAdmin, withTenant } from '@/db/tenant'
import { creerProspect } from '@/inspections/prospect'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

let f: Fixtures
let fi: FixturesInspections
const prospectsCrees: string[] = []

const tenantA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 })

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
  // DÉSACTIVE (entreprise.desactive_le, cf. 0010), il ne se supprime pas.
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

describe('Cloisonnement B5 — un client ne voit pas les inspections d’un autre', () => {
  it('inspection : A ne voit que la sienne', async () => {
    const ids = (await withTenant(tenantA(), (trx) => trx.selectFrom('inspection').select('id').execute())).map((r) => r.id)
    expect(ids).toContain(fi.inspectionA)
    expect(ids).toContain(fi.inspectionA2)
    expect(ids).not.toContain(fi.inspectionB)
  })

  it('item_inspection : A ne voit que ses items', async () => {
    const ids = (await withTenant(tenantA(), (trx) => trx.selectFrom('item_inspection').select('id').execute())).map((r) => r.id)
    expect(ids).toContain(fi.itemA1)
    expect(ids).not.toContain(fi.itemB1)
  })

  it('non_conformite : A ne voit que la sienne', async () => {
    const ids = (await withTenant(tenantA(), (trx) => trx.selectFrom('non_conformite').select('id').execute())).map((r) => r.id)
    expect(ids).toContain(fi.ncA)
    expect(ids).not.toContain(fi.ncB)
  })

  it("écrire une inspection en usurpant l'entreprise_id d'un AUTRE tenant est rejeté", async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('inspection')
          .values({
            entreprise_id: f.entrepriseB,
            modele_id: fi.modeleCatalogue,
            intitule_modele: 'x',
            cible_type: 'site',
            site_id: fi.siteB,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  // Règle mixte (migration 0012) : le DELETE applicatif existe, mais une
  // inspection clôturée ou porteuse de NC est refusée par le garde-fou en base.
  it('DELETE applicatif refusé en base sur une inspection clôturée avec NC (elle s’annule, elle ne disparaît pas)', async () => {
    await expect(
      withTenant(tenantA(), (trx) => trx.deleteFrom('inspection').where('id', '=', fi.inspectionA).execute()),
    ).rejects.toThrow(/doit d'abord être rangée/)
  })

  it('DELETE applicatif cloisonné : depuis B, l’inspection de A n’est pas atteinte', async () => {
    const r = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) =>
      trx.deleteFrom('inspection').where('id', '=', fi.inspectionA2).executeTakeFirst())
    expect(Number(r.numDeletedRows)).toBe(0)
  })
})

describe('Modèles d’inspection — catalogue IFECARM en lecture partagée', () => {
  it('A lit le modèle du catalogue et ses items', async () => {
    const modeles = await withTenant(tenantA(), (trx) => trx.selectFrom('modele_inspection').select('id').execute())
    expect(modeles.map((m) => m.id)).toContain(fi.modeleCatalogue)
    const items = await withTenant(tenantA(), (trx) =>
      trx.selectFrom('item_modele_inspection').select('id').where('modele_id', '=', fi.modeleCatalogue).execute(),
    )
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  it('un utilisateur normal ne peut modifier ni le modèle ni ses items du catalogue', async () => {
    const maj = await withTenant(tenantA(), (trx) =>
      trx.updateTable('modele_inspection').set({ intitule: 'piraté' }).where('id', '=', fi.modeleCatalogue).executeTakeFirst(),
    )
    expect(Number(maj.numUpdatedRows)).toBe(0)

    await expect(
      withTenant(tenantA(), (trx) =>
        trx.insertInto('item_modele_inspection').values({ modele_id: fi.modeleCatalogue, ordre: 99, libelle: 'piraté' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('admin_plateforme peut modifier le catalogue, et c’est journalisé', async () => {
    const maj = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'gerer_catalogue_inspection', details: { modele: fi.modeleCatalogue } },
      (trx) =>
        trx.updateTable('modele_inspection').set({ description: 'mis à jour par la plateforme' }).where('id', '=', fi.modeleCatalogue).executeTakeFirst(),
    )
    expect(Number(maj.numUpdatedRows)).toBe(1)
  })
})

describe('admin_plateforme voit toutes les inspections', () => {
  it('les inspections de A et de B sont visibles', async () => {
    const ids = (
      await withPlatformAdmin({ utilisateurId: f.adminPlateformeP1, operation: 'lister_entreprises' }, (trx) =>
        trx.selectFrom('inspection').select('id').execute(),
      )
    ).map((r) => r.id)
    expect(ids).toContain(fi.inspectionA)
    expect(ids).toContain(fi.inspectionB)
  })
})

describe('creer_prospect() — création terrain par le consultant', () => {
  let prospectId: string
  let siteProspect: string

  it('un consultant crée un prospect : statut prospect, trois modules (inspections, tableau de bord, autodiagnostic), accès en écriture sans délai, pour lui seul', async () => {
    prospectId = await withAuthenticatedUser(f.consultantC1, (trx) =>
      creerProspect(trx, { nom: `Prospect test ${fi.suffixe}`, pays: 'BJ', secteur: 'BTP' }),
    )
    prospectsCrees.push(prospectId)

    const lu = await avecMigrate(async (c) => ({
      entreprise: (await c.query('SELECT statut_relation, interne FROM entreprise WHERE id = $1', [prospectId])).rows[0],
      modules: (await c.query('SELECT module FROM abonnement_module WHERE entreprise_id = $1 ORDER BY module', [prospectId])).rows.map((r) => r.module),
      acces: (await c.query('SELECT utilisateur_id, ecriture, fin_le::text FROM acces_consultant WHERE entreprise_id = $1', [prospectId])).rows,
      journal: (await c.query("SELECT entreprise_id, utilisateur_id FROM journal_audit WHERE action = 'creer_prospect' AND objet_id = $1", [prospectId])).rows,
    }))
    expect(lu.entreprise).toEqual({ statut_relation: 'prospect', interne: false })
    expect(lu.modules).toEqual(['autodiagnostic', 'inspections', 'tableau_bord'])
    expect(lu.acces).toHaveLength(1)
    expect(lu.acces[0]).toMatchObject({ utilisateur_id: f.consultantC1, ecriture: true })
    expect(lu.acces[0].fin_le).toBeNull()   // plus de délai (migration 0024)
    // Journalisé, sans clé étrangère vers l'entreprise (purge possible).
    expect(lu.journal).toEqual([{ entreprise_id: null, utilisateur_id: f.consultantC1 }])
  })

  it('le consultant entre dans SON prospect, y crée site et inspection, et les relit', async () => {
    await withAuthenticatedUser(f.consultantC1, (trx) =>
      exigerAccesConsultant(trx, { utilisateurId: f.consultantC1, entrepriseId: prospectId, ecriture: true }),
    )
    const ctx = { entrepriseId: prospectId, utilisateurId: f.consultantC1 }
    siteProspect = (
      await withTenant(ctx, (trx) =>
        trx.insertInto('site').values({ entreprise_id: prospectId, nom: 'Chantier du prospect' }).returning('id').executeTakeFirstOrThrow(),
      )
    ).id
    const inspectionId = (
      await withTenant(ctx, (trx) =>
        trx
          .insertInto('inspection')
          .values({
            entreprise_id: prospectId,
            modele_id: fi.modeleCatalogue,
            intitule_modele: 'Modèle catalogue (test)',
            cible_type: 'site',
            site_id: siteProspect,
            consultant_id: f.consultantC1,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id
    const relu = await withTenant(ctx, (trx) => trx.selectFrom('inspection').select('id').execute())
    expect(relu.map((r) => r.id)).toEqual([inspectionId])
  })

  it('un autre consultant, sans accès, n’en obtient aucun ; un client ne voit rien du prospect', async () => {
    const acces = await withAuthenticatedUser(fi.consultantSansAcces, (trx) =>
      accesConsultantValide(trx, { utilisateurId: fi.consultantSansAcces, entrepriseId: prospectId }),
    )
    expect(acces).toBeNull()

    const inspectionsVuesParA = await withTenant(tenantA(), (trx) => trx.selectFrom('inspection').select('entreprise_id').execute())
    expect(inspectionsVuesParA.some((i) => i.entreprise_id === prospectId)).toBe(false)
  })

  it('un utilisateur qui n’est pas consultant IFECARM ne peut pas créer de prospect', async () => {
    await expect(
      withAuthenticatedUser(f.utilisateurA1, (trx) => creerProspect(trx, { nom: 'Interdit', pays: 'BJ' })),
    ).rejects.toThrow(/réservé aux consultants/)
  })

  it('nom vide et durée d’accès hors bornes sont rejetés', async () => {
    await expect(
      withAuthenticatedUser(f.consultantC1, (trx) => creerProspect(trx, { nom: '   ', pays: 'BJ' })),
    ).rejects.toThrow(/nom et pays obligatoires/)
    await expect(
      withAuthenticatedUser(f.consultantC1, (trx) => creerProspect(trx, { nom: 'X', pays: 'BJ', dureeAccesJours: 0 })),
    ).rejects.toThrow(/hors bornes/)
  })

  it('un prospect ne peut pas activer un module réservé aux clients, sauf après conversion', async () => {
    await avecMigrate(async (c) => {
      await expect(
        c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'formations')", [prospectId]),
      ).rejects.toThrow(/ne peut pas être activé pour un prospect/)

      await c.query("UPDATE entreprise SET statut_relation = 'client' WHERE id = $1", [prospectId])
      await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'formations')", [prospectId])

      // Et l'inverse : repasser en prospect avec un module client actif est refusé.
      await expect(
        c.query("UPDATE entreprise SET statut_relation = 'prospect' WHERE id = $1", [prospectId]),
      ).rejects.toThrow(/impossible de la repasser en prospect/)
    })
  })

  it('la conversion garde ses inspections : aucune donnée à migrer', async () => {
    const ids = (
      await withTenant({ entrepriseId: prospectId, utilisateurId: f.consultantC1 }, (trx) =>
        trx.selectFrom('inspection').select('id').execute(),
      )
    ).map((r) => r.id)
    expect(ids).toHaveLength(1)
  })
})

describe('Clés étrangères composites B5 — la base refuse, pas seulement la politique', () => {
  it('une inspection de A ne peut pas viser le site de B', async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('inspection')
          .values({
            entreprise_id: f.entrepriseA,
            modele_id: fi.modeleCatalogue,
            intitule_modele: 'x',
            cible_type: 'site',
            site_id: fi.siteB,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it("un item de A ne peut pas être rattaché à l'inspection de B", async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('item_inspection')
          .values({ entreprise_id: f.entrepriseA, inspection_id: fi.inspectionB, ordre: 50, libelle: 'x' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it("une non-conformité ne peut pas citer l'item d'une AUTRE inspection, même de la même entreprise", async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('non_conformite')
          .values({
            entreprise_id: f.entrepriseA,
            inspection_id: fi.inspectionA,
            item_inspection_id: fi.itemA2Insp2, // item de inspectionA2
            gravite: 'mineure',
            description: 'x',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it("une inspection ne peut avoir qu'une cible, cohérente avec cible_type", async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('inspection')
          .values({
            entreprise_id: f.entrepriseA,
            modele_id: fi.modeleCatalogue,
            intitule_modele: 'x',
            cible_type: 'site',
            site_id: fi.siteA,
            equipement_id: fi.equipementA,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it("une inspection d'équipement de A est acceptée", async () => {
    const id = (
      await withTenant(tenantA(), (trx) =>
        trx
          .insertInto('inspection')
          .values({
            entreprise_id: f.entrepriseA,
            modele_id: fi.modeleCatalogue,
            intitule_modele: 'x',
            cible_type: 'equipement',
            equipement_id: fi.equipementA,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id
    expect(id).toBeTruthy()
  })
})

describe('Plan d’action = action_corrective d’origine inspection', () => {
  it('une action d’origine inspection doit citer une non-conformité de la MÊME entreprise', async () => {
    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('action_corrective')
          .values({
            entreprise_id: f.entrepriseA,
            reference: `ACT-X-${randomUUID().slice(0, 8)}`,
            origine_type: 'inspection',
            origine_id: fi.ncB, // non-conformité de B
            libelle: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/non-conformité de la même entreprise/)

    await expect(
      withTenant(tenantA(), (trx) =>
        trx
          .insertInto('action_corrective')
          .values({
            entreprise_id: f.entrepriseA,
            reference: `ACT-Y-${randomUUID().slice(0, 8)}`,
            origine_type: 'inspection',
            origine_id: randomUUID(), // n'existe pas
            libelle: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/non-conformité de la même entreprise/)
  })

  it('une action d’origine inspection sur une non-conformité de A est acceptée', async () => {
    const id = (
      await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.consultantC1 }, (trx) => // écriture réservée à l'équipe IFECARM (0035)
        trx
          .insertInto('action_corrective')
          .values({
            entreprise_id: f.entrepriseA,
            reference: `ACT-OK-${randomUUID().slice(0, 8)}`,
            origine_type: 'inspection',
            origine_id: fi.ncA,
            libelle: 'Former le personnel au registre',
            echeance: '2099-01-01',
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id
    expect(id).toBeTruthy()
  })
})
