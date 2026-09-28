import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withPlatformAdmin, withTenant } from '@/db/tenant'
import { indicateursPlateforme, resumePlateforme } from '@/tableau-bord/plateforme'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

let f: Fixtures
let fi: FixturesInspections

const tenantA = () => ({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 })
const tenantB = () => ({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 })

beforeAll(async () => {
  f = await creerFixtures()
  fi = await creerFixturesInspections(f)
})

afterAll(async () => {
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

describe('Vues client (security_invoker) — cloisonnées par la RLS des tables sous-jacentes', () => {
  it.each([
    'v_indicateurs_formations',
    'v_indicateurs_registre',
    'v_indicateurs_actions',
    'v_indicateurs_inspections',
  ] as const)('%s : A ne voit que sa propre ligne', async (vue) => {
    const rows = await withTenant(tenantA(), (trx) => trx.selectFrom(vue).select('entreprise_id').execute())
    expect(rows).toEqual([{ entreprise_id: f.entrepriseA }])
  })

  it('v_indicateurs_inspections : les valeurs de A sont calculées sur ses seules données', async () => {
    const [row] = await withTenant(tenantA(), (trx) => trx.selectFrom('v_indicateurs_inspections').selectAll().execute())
    // A : 2 items conformes, 1 non conforme, 1 non applicable (exclu) → 2/3.
    expect(row).toMatchObject({
      inspections_terminees_90j: 1,
      items_conformes_90j: 2,
      items_non_conformes_90j: 1,
      nc_ouvertes_critique: 1,
      nc_ouvertes_majeure: 0,
      nc_ouvertes_mineure: 0,
    })
    expect(Number(row!.taux_conformite_90j)).toBeCloseTo(0.6667, 4)
  })

  it('v_indicateurs_inspections : B a ses propres valeurs (aucun mélange avec A)', async () => {
    const [row] = await withTenant(tenantB(), (trx) => trx.selectFrom('v_indicateurs_inspections').selectAll().execute())
    expect(row).toMatchObject({ items_conformes_90j: 0, items_non_conformes_90j: 1, nc_ouvertes_mineure: 1, nc_ouvertes_critique: 0 })
    expect(Number(row!.taux_conformite_90j)).toBe(0)
  })

  it("v_indicateurs_actions : l'action d'inspection de A, en retard, est comptée", async () => {
    const [row] = await withTenant(tenantA(), (trx) => trx.selectFrom('v_indicateurs_actions').selectAll().execute())
    expect(row).toMatchObject({ actions_en_retard: 1, actions_inspection_en_retard: 1 })
  })

  it("une non-conformité traitée (action réalisée) n'est plus comptée comme ouverte", async () => {
    await withTenant(tenantA(), (trx) =>
      trx
        .updateTable('action_corrective')
        .set({ statut: 'realisee', realisee_le: new Date() })
        .where('id', '=', fi.actionA)
        .execute(),
    )
    const [row] = await withTenant(tenantA(), (trx) => trx.selectFrom('v_indicateurs_inspections').selectAll().execute())
    expect(row).toMatchObject({ nc_ouvertes_critique: 0 })
    const [actions] = await withTenant(tenantA(), (trx) => trx.selectFrom('v_indicateurs_actions').selectAll().execute())
    // Réalisée le jour même, échéance hier : terminée, mais pas dans les délais.
    expect(actions).toMatchObject({ actions_en_retard: 0, terminees_avec_echeance: 1, terminees_dans_les_delais: 0 })
    expect(Number(actions!.taux_traitement_delais)).toBe(0)
  })

  it('une vue ne rend rien sans contexte de tenant (jamais le contenu de toutes les entreprises)', async () => {
    const { withoutTenant } = await import('@/db/tenant')
    const rows = await withoutTenant((trx) => trx.selectFrom('v_indicateurs_inspections').select('entreprise_id').execute())
    expect(rows).toEqual([])
  })
})

describe('Vue transverse IFECARM — fonctions SECURITY DEFINER, comptages purs', () => {
  it('un utilisateur normal (même dans son tenant) est refusé', async () => {
    await expect(withTenant(tenantA(), (trx) => indicateursPlateforme(trx))).rejects.toThrow(/admin_plateforme/)
    await expect(withTenant(tenantA(), (trx) => resumePlateforme(trx))).rejects.toThrow(/admin_plateforme/)
  })

  it('un consultant IFECARM (qui n’est pas admin_plateforme) est refusé', async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.consultantC1 }, (trx) => indicateursPlateforme(trx)),
    ).rejects.toThrow(/admin_plateforme/)
  })

  it('le contexte platform_admin seul ne suffit pas : le rôle est revérifié dans la fonction', async () => {
    // withPlatformAdmin refuse déjà un non-admin ; on force donc le contexte à la main,
    // comme le ferait un bug applicatif, pour prouver que la base se défend seule.
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, async (trx) => {
        await sql`select set_config('app.platform_admin', 'true', true)`.execute(trx)
        return indicateursPlateforme(trx)
      }),
    ).rejects.toThrow(/rôle absent/)
  })

  it('admin_plateforme obtient une ligne par client, avec les bons chiffres', async () => {
    const lignes = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_indicateurs_plateforme' },
      (trx) => indicateursPlateforme(trx),
    )
    const a = lignes.find((l) => l.entreprise_id === f.entrepriseA)
    const b = lignes.find((l) => l.entreprise_id === f.entrepriseB)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toMatchObject({ statut_relation: 'client', inspections_terminees_90j: 1 })
    expect(b).toMatchObject({ nc_ouvertes_total: 1, nc_ouvertes_critique: 0 })
    // L'entreprise interne IFECARM n'y figure pas.
    expect(lignes.some((l) => l.entreprise_id === f.ifecarmInterne)).toBe(false)
  })

  it("la réponse ne contient que des comptages : aucune colonne de donnée personnelle ou de contenu", async () => {
    const lignes = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_indicateurs_plateforme' },
      (trx) => indicateursPlateforme(trx),
    )
    const colonnes = new Set(Object.keys(lignes[0]!))
    expect([...colonnes].sort()).toEqual(
      [
        'actif', 'actions_en_retard', 'actions_inspection_en_retard', 'declarations_ouvertes',
        'entreprise_id', 'inspections_terminees_90j', 'nc_ouvertes_critique', 'nc_ouvertes_total',
        'nom', 'recyclages_30j', 'recyclages_7j', 'recyclages_depasses', 'statut_relation',
        'taux_conformite_90j',
      ].sort(),
    )
  })

  it('resume_plateforme compte clients et prospects', async () => {
    const resume = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_indicateurs_plateforme' },
      (trx) => resumePlateforme(trx),
    )
    expect(resume.clients_actifs).toBeGreaterThanOrEqual(2) // au moins A et B
    expect(resume.prospects).toBeGreaterThanOrEqual(0)
    expect(resume.entreprises_desactivees).toBeGreaterThanOrEqual(0)
  })

  it("l'appel est journalisé avant tout effet (comme toute opération admin_plateforme)", async () => {
    await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_indicateurs_plateforme' },
      (trx) => resumePlateforme(trx),
    )
    const journal = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
      (trx) =>
        trx
          .selectFrom('journal_audit')
          .select('id')
          .where('utilisateur_id', '=', f.adminPlateformeP1)
          .where('action', '=', 'consulter_indicateurs_plateforme')
          .execute(),
    )
    expect(journal.length).toBeGreaterThan(0)
  })
})
