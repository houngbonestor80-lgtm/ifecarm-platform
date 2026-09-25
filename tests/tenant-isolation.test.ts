/**
 * Tests les plus importants du projet (cf. tâche) : ils tentent
 * explicitement d'accéder aux données d'une autre entreprise et vérifient
 * que la base refuse — pas seulement que le code applicatif s'en abstient.
 *
 * Nécessite une base réelle migrée : `npm run db:up && npm run migrate`
 * avant `npm run test`. Toutes les assertions passent par ifecarm_app
 * (withTenant/withAuthenticatedUser/withPlatformAdmin/withoutTenant) —
 * jamais par ifecarm_migrate, qui est exempté du RLS en tant que
 * propriétaire (cf. dernier bloc de ce fichier, qui le démontre).
 */
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withAuthenticatedUser, withPlatformAdmin, withTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

let f: Fixtures

beforeAll(async () => {
  f = await creerFixtures()
})

afterAll(async () => {
  // Si beforeAll a échoué (ex. migrations pas appliquées), f n'a jamais été
  // assigné — inutile de faire planter le nettoyage par-dessus une erreur
  // déjà claire à propos d'autre chose.
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré volontairement, cf. commentaire ci-dessus
  }
})

describe('Lecture cloisonnée (clause USING)', () => {
  it("un utilisateur de l'entreprise A ne voit que les salariés de A", async () => {
    const salaries = await withTenant(
      { entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 },
      (trx) => trx.selectFrom('salarie').select(['id', 'entreprise_id']).execute(),
    )
    const ids = salaries.map((s) => s.id)
    expect(ids).toContain(f.salarieA1)
    expect(ids).not.toContain(f.salarieB1)
    expect(salaries.every((s) => s.entreprise_id === f.entrepriseA)).toBe(true)
  })

  it('même une requête sans filtre explicite sur entreprise ne fuite jamais un autre tenant', async () => {
    const entreprisesVisibles = await withTenant(
      { entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 },
      (trx) => trx.selectFrom('entreprise').select('id').execute(),
    )
    expect(entreprisesVisibles.map((e) => e.id)).toEqual([f.entrepriseA])
  })
})

describe('Écriture cloisonnée (clause WITH CHECK — absente du schéma fourni initialement)', () => {
  it("insérer un salarié en usurpant l'entreprise_id d'un AUTRE tenant est rejeté", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx.insertInto('salarie').values({ entreprise_id: f.entrepriseB, nom: 'Intrus', prenom: 'Test' }).execute(),
      ),
    ).rejects.toThrow()
  })

  it("modifier un salarié d'un AUTRE tenant (id connu) affecte zéro ligne, sans erreur", async () => {
    const resultat = await withTenant(
      { entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 },
      (trx) =>
        trx.updateTable('salarie').set({ poste: 'Modifié par A' }).where('id', '=', f.salarieB1).executeTakeFirst(),
    )
    expect(Number(resultat.numUpdatedRows)).toBe(0)
  })
})

describe('role_utilisateur — pas de colonne entreprise_id directe, cloisonné par jointure', () => {
  it("un admin de A ne voit pas les rôles des utilisateurs de B", async () => {
    const roles = await withTenant(
      { entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 },
      (trx) => trx.selectFrom('role_utilisateur').select(['utilisateur_id']).execute(),
    )
    expect(roles.map((r) => r.utilisateur_id)).not.toContain(f.utilisateurB1)
  })

  it('un utilisateur authentifié sans entreprise choisie voit SES PROPRES rôles (résolution post-connexion)', async () => {
    const roles = await withAuthenticatedUser(f.utilisateurA1, (trx) =>
      trx.selectFrom('role_utilisateur').select(['role']).where('utilisateur_id', '=', f.utilisateurA1).execute(),
    )
    expect(roles.map((r) => r.role)).toContain('admin_entreprise')
  })
})

describe('acces_consultant — cloisonnement à double clé (entreprise cliente OU consultant lui-même)', () => {
  it("le consultant voit son accès à B avant même d'avoir choisi une entreprise", async () => {
    const acces = await withAuthenticatedUser(f.consultantC1, (trx) =>
      trx
        .selectFrom('acces_consultant')
        .select(['entreprise_id'])
        .where('utilisateur_id', '=', f.consultantC1)
        .execute(),
    )
    expect(acces.map((a) => a.entreprise_id)).toContain(f.entrepriseB)
  })

  it("un utilisateur de A ne voit aucun accès consultant accordé sur B", async () => {
    const acces = await withTenant(
      { entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 },
      (trx) => trx.selectFrom('acces_consultant').select('id').execute(),
    )
    expect(acces).toHaveLength(0)
  })

  it("un admin d'entreprise (pas admin_plateforme) ne peut pas accorder lui-même un accès consultant", async () => {
    await expect(
      withTenant({ entrepriseId: f.entrepriseA, utilisateurId: f.utilisateurA1 }, (trx) =>
        trx
          .insertInto('acces_consultant')
          .values({ utilisateur_id: f.consultantC1, entreprise_id: f.entrepriseA, ecriture: false })
          .execute(),
      ),
    ).rejects.toThrow()
  })
})

describe('withPlatformAdmin — liste fermée + revérification du rôle + journalisation avant effet', () => {
  it('refuse un utilisateur sans le rôle admin_plateforme, sans aucun effet de bord', async () => {
    await expect(
      withPlatformAdmin(
        { utilisateurId: f.utilisateurA1, operation: 'lister_entreprises' },
        async (trx) => trx.selectFrom('entreprise').select('id').execute(),
      ),
    ).rejects.toThrow()

    // journal_audit a sa propre politique RLS (contrairement à session/
    // password_reset_token/tentative_connexion) : withoutTenant n'y verrait
    // JAMAIS aucune ligne, quel que soit son contenu réel — l'assertion
    // serait vraie à vide et ne démontrerait rien. On vérifie donc depuis un
    // contexte qui PEUT réellement voir la table : withPlatformAdmin.
    const journal = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
      (trx) =>
        trx
          .selectFrom('journal_audit')
          .select('id')
          .where('utilisateur_id', '=', f.utilisateurA1)
          .where('action', '=', 'lister_entreprises')
          .execute(),
    )
    expect(journal).toHaveLength(0)
  })

  it('un vrai admin_plateforme voit toutes les entreprises, et l’opération est journalisée', async () => {
    const entreprises = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'lister_entreprises' },
      (trx) => trx.selectFrom('entreprise').select('id').execute(),
    )
    const ids = entreprises.map((e) => e.id)
    expect(ids).toContain(f.entrepriseA)
    expect(ids).toContain(f.entrepriseB)

    const journal = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
      (trx) =>
        trx
          .selectFrom('journal_audit')
          .select('id')
          .where('utilisateur_id', '=', f.adminPlateformeP1)
          .where('action', '=', 'lister_entreprises')
          .execute(),
    )
    expect(journal.length).toBeGreaterThan(0)
  })
})

describe("journal_audit — immuabilité (déclencheur)", () => {
  it('une tentative de modification est rejetée', async () => {
    // Même remarque que ci-dessus : il faut un contexte qui voit réellement
    // la table pour que le trigger ait une ligne à refuser de modifier — un
    // UPDATE dont la clause RLS ne matche aucune ligne affecterait
    // silencieusement zéro ligne, sans jamais déclencher le trigger, et le
    // test passerait pour la mauvaise raison.
    const [entry] = await withPlatformAdmin(
      { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
      (trx) => trx.selectFrom('journal_audit').select('id').limit(1).execute(),
    )
    expect(entry).toBeDefined()

    await expect(
      withPlatformAdmin(
        { utilisateurId: f.adminPlateformeP1, operation: 'consulter_journal_audit_global' },
        (trx) => trx.updateTable('journal_audit').set({ action: 'modifie' }).where('id', '=', entry!.id).execute(),
      ),
    ).rejects.toThrow()
  })
})

describe('Contrôle négatif : le rôle propriétaire EST exempté du RLS', () => {
  it('ifecarm_migrate voit les deux entreprises sans aucune variable de session — la preuve que les tests ci-dessus démontrent bien quelque chose', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    const { rows } = await client.query('SELECT id FROM entreprise WHERE id = ANY($1)', [
      [f.entrepriseA, f.entrepriseB],
    ])
    await client.end()
    expect(rows).toHaveLength(2)
  })
})
