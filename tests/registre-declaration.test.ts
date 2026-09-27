import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { creerDeclaration } from '@/registre/declarations'
import { withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

let f: Fixtures

beforeAll(async () => {
  f = await creerFixtures()
})

afterAll(async () => {
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré, cf. tests/tenant-isolation.test.ts
  }
})

function paramsBase(overrides: Partial<Parameters<typeof creerDeclaration>[1]> = {}) {
  return {
    entrepriseId: f.entrepriseA,
    utilisateurId: f.utilisateurA1,
    type: 'presqu_accident',
    survenuLe: new Date(),
    description: 'Test',
    anonyme: false,
    saisiHorsLigne: true,
    ...overrides,
  }
}

describe('Idempotence du rejeu de synchronisation', () => {
  it('deux envois identiques (même cle_client) ne créent qu’une ligne et renvoient le même id/référence', async () => {
    const cleClient = randomUUID()
    const params = paramsBase({ cleClient })

    const premier = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, params),
    )
    const second = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, params),
    )

    expect(second).toEqual(premier)

    const lignes = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('declaration').select('id').where('cle_client', '=', cleClient).execute(),
    )
    expect(lignes).toHaveLength(1)
  })

  it("le rejeu ne double ni l'historique ni la notification (effet de bord une seule fois)", async () => {
    const cleClient = randomUUID()
    const params = paramsBase({ cleClient })

    const resultat = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, params),
    )
    await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, params),
    )

    const historique = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx.selectFrom('historique_declaration').select('id').where('declaration_id', '=', resultat.id).execute(),
    )
    expect(historique).toHaveLength(1)

    const notifications = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .selectFrom('notification')
        .select('id')
        .where('corps', 'like', `%${resultat.reference}%`)
        .execute(),
    )
    // Une seule notification : f.utilisateurA1 (admin_entreprise) est l'unique destinataire.
    expect(notifications).toHaveLength(1)
  })
})

describe('Génération de référence sans condition de course', () => {
  it('deux créations concurrentes pour la même entreprise obtiennent des références distinctes', async () => {
    const [d1, d2] = await Promise.all([
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        creerDeclaration(trx, paramsBase({ cleClient: randomUUID() })),
      ),
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        creerDeclaration(trx, paramsBase({ cleClient: randomUUID() })),
      ),
    ])

    expect(d1.reference).not.toBe(d2.reference)
    expect(d1.reference).toMatch(/^INC-\d{4}-\d{4}$/)
  })
})

describe('Anonymat — ne fuite ni dans journal_audit ni dans la notification', () => {
  it("journal_audit ne porte aucun utilisateur_id pour une déclaration anonyme", async () => {
    const declaration = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, paramsBase({ anonyme: true, cleClient: randomUUID() })),
    )

    const journal = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .selectFrom('journal_audit')
        .select('utilisateur_id')
        .where('objet_id', '=', declaration.id)
        .where('objet_type', '=', 'declaration')
        .execute(),
    )
    expect(journal.length).toBeGreaterThan(0)
    expect(journal.every((j) => j.utilisateur_id === null)).toBe(true)
  })

  it("la notification déposée ne contient que la référence — jamais l'identité du déclarant ou de l'appelant authentifié", async () => {
    const declaration = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      creerDeclaration(trx, paramsBase({ anonyme: true, cleClient: randomUUID() })),
    )

    const notifications = await withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
      trx
        .selectFrom('notification')
        .select(['sujet', 'corps'])
        .where('corps', 'like', `%${declaration.reference}%`)
        .execute(),
    )
    expect(notifications.length).toBeGreaterThan(0)
    for (const n of notifications) {
      // Égalité stricte au gabarit attendu, pas un simple "ne contient pas" :
      // garantit qu'aucun champ d'identité n'a pu s'y glisser, par construction.
      expect(n.sujet).toBe('Nouvelle déclaration à qualifier')
      expect(n.corps).toBe(
        `Une nouvelle déclaration (${declaration.reference}) a été enregistrée et attend qualification.`,
      )
    }
  })
})
