import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesRegistre, type FixturesRegistre } from './fixtures-registre'

let f: Fixtures
let fr: FixturesRegistre

beforeAll(async () => {
  f = await creerFixtures()
  fr = await creerFixturesRegistre(f)
})

afterAll(async () => {
  // fichier/declaration/action_corrective/etc. sont tous cascadés depuis
  // entreprise (cf. fixtures-registre.ts) : le socle seul suffit à nettoyer.
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré, cf. tests/tenant-isolation.test.ts
  }
})

describe('Cloisonnement par table — module registre', () => {
  it('declaration : A ne voit que sa propre déclaration', async () => {
    const declarations = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('declaration').select('id').execute(),
    )
    const ids = declarations.map((d) => d.id)
    expect(ids).toContain(fr.declarationA)
    expect(ids).not.toContain(fr.declarationB)
  })

  it('piece_jointe_declaration : A ne voit que sa propre pièce jointe', async () => {
    const pieces = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('piece_jointe_declaration').select(['id', 'declaration_id']).execute(),
    )
    expect(pieces.every((p) => p.declaration_id === fr.declarationA)).toBe(true)
  })

  it('analyse_cause : A ne voit que sa propre analyse', async () => {
    const analyses = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('analyse_cause').select(['id', 'declaration_id']).execute(),
    )
    expect(analyses.every((a) => a.declaration_id === fr.declarationA)).toBe(true)
  })

  it('action_corrective : A ne voit que sa propre action', async () => {
    const actions = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('action_corrective').select('id').execute(),
    )
    const ids = actions.map((a) => a.id)
    expect(ids).toContain(fr.actionA)
    expect(ids).not.toContain(fr.actionB)
  })

  it('relance_action : A ne voit que sa propre relance', async () => {
    const relances = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('relance_action').select(['id', 'action_id']).execute(),
    )
    expect(relances.every((r) => r.action_id === fr.actionA)).toBe(true)
  })

  it('historique_declaration : A ne voit que son propre historique', async () => {
    const historique = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('historique_declaration').select(['id', 'declaration_id']).execute(),
    )
    expect(historique.every((h) => h.declaration_id === fr.declarationA)).toBe(true)
  })

  it("écrire une déclaration en usurpant l'entreprise_id d'un AUTRE tenant est rejeté", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('declaration')
          .values({
            entreprise_id: f.entrepriseB,
            reference: 'INTRUS',
            type: 'presqu_accident',
            survenu_le: new Date(),
            description: 'Intrusion',
          })
          .execute(),
      ),
    ).rejects.toThrow()
  })
})

describe('v_declaration_mensuelle — cloisonnée malgré son propriétaire (security_invoker)', () => {
  it('A ne voit que ses propres déclarations à travers la vue', async () => {
    const lignes = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('v_declaration_mensuelle').select('entreprise_id').execute(),
    )
    expect(lignes.every((l) => l.entreprise_id === f.entrepriseA)).toBe(true)
  })
})

describe('Garde-fou structurel : toute vue du projet est security_invoker', () => {
  it("aucune vue n'exécute avec les droits de son propriétaire (sans quoi le RLS de ses tables sous-jacentes ne s'applique plus au rôle appelant)", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      WHERE c.relkind = 'v'
        AND c.relnamespace = 'public'::regnamespace
        AND NOT coalesce(
          (SELECT true FROM unnest(c.reloptions) o WHERE o = 'security_invoker=true'),
          false
        )
    `)
    await client.end()
    expect(rows).toEqual([])
  })
})
