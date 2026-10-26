import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { creerDeclaration } from '@/registre/declarations'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Migration 0035 (B3) : écriture client = déclarer seulement, lecture par rôle, anonymat,
 * références croisées entre entreprises, faits figés après qualification, historique tenu par la
 * base, cohérence des actions. Toutes les assertions passent par ifecarm_app (withTenant) ;
 * ifecarm_migrate ne sert qu'à préparer.
 */

let f: Fixtures
let declarant1: string
let declarant2: string
let responsableQhse: string
let fichierA: string
let fichierB: string
let siteB: string
let declarationB: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const A = (utilisateurId: string) => ({ entrepriseId: f.entrepriseA, utilisateurId })
const consultant = () => A(f.consultantC1)
const nbModifiees = (r: { numUpdatedRows?: bigint, numDeletedRows?: bigint }) => Number(r.numUpdatedRows ?? r.numDeletedRows ?? 0)

const base = (utilisateurId: string, extra: Record<string, unknown> = {}) => ({
  entrepriseId: f.entrepriseA, utilisateurId, type: 'presqu_accident', survenuLe: new Date(),
  description: 'Test B3', anonyme: false, saisiHorsLigne: false, ...extra,
}) as Parameters<typeof creerDeclaration>[1]
const declarer = (utilisateurId: string, extra: Record<string, unknown> = {}) =>
  withTenant(A(utilisateurId), (trx) => creerDeclaration(trx, base(utilisateurId, extra)))
const lire = (utilisateurId: string) =>
  withTenant(A(utilisateurId), (trx) => trx.selectFrom('declaration').select(['id', 'anonyme']).execute())

async function creerUtilisateur(c: Client, label: string, role: string): Promise<string> {
  const { rows: [u] } = await c.query(
    'INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, $3) RETURNING id',
    [f.entrepriseA, `${label}-${randomUUID().slice(0, 8)}@test.local`, label])
  await c.query('INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, $2)', [u.id, role])
  return u.id
}

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    declarant1 = await creerUtilisateur(c, 'declarant1', 'declarant')
    declarant2 = await creerUtilisateur(c, 'declarant2', 'declarant')
    responsableQhse = await creerUtilisateur(c, 'qhse', 'responsable_qhse')
    const s = randomUUID().slice(0, 8)
    fichierA = (await c.query('INSERT INTO fichier (entreprise_id, cle_stockage, nom_origine) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseA, `b3/${s}-a`, 'a.jpg'])).rows[0].id
    fichierB = (await c.query('INSERT INTO fichier (entreprise_id, cle_stockage, nom_origine) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseB, `b3/${s}-b`, 'b.jpg'])).rows[0].id
    siteB = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site B3') RETURNING id", [f.entrepriseB])).rows[0].id
    declarationB = (await c.query(
      "INSERT INTO declaration (entreprise_id, reference, type, survenu_le, description) VALUES ($1, $2, 'presqu_accident', now(), 'B') RETURNING id",
      [f.entrepriseB, `B3-B-${s}`])).rows[0].id
  })
})

afterAll(async () => {
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('Écriture : le client déclare, rien d’autre', () => {
  it('un déclarant crée sa déclaration (nominative ou anonyme) mais jamais au nom d’un autre ni déjà qualifiée', async () => {
    expect((await declarer(declarant1)).reference).toMatch(/^INC-/)
    expect((await declarer(declarant1, { anonyme: true })).id).toBeTruthy()
    await expect(declarer(declarant1, { declarantId: declarant2 })).rejects.toThrow(/row-level security/)
    await expect(withTenant(A(declarant1), (trx) => trx.insertInto('declaration').values({
      entreprise_id: f.entrepriseA, reference: `X-${randomUUID().slice(0, 6)}`, type: 'presqu_accident', survenu_le: new Date(),
      description: 'x', declarant_id: declarant1, statut: 'en_analyse', gravite: 2, frequence: 2,
    }).execute())).rejects.toThrow(/row-level security/)
  })

  it('un déclarant ne peut ni modifier, ni supprimer, ni qualifier, ni analyser, ni créer d’action ou de relance', async () => {
    const d = await declarer(declarant1)
    const t = A(declarant1)
    expect(nbModifiees(await withTenant(t, (trx) => trx.updateTable('declaration').set({ description: 'modifiée' }).where('id', '=', d.id).executeTakeFirst()))).toBe(0)
    await expect(withTenant(t, (trx) => trx.deleteFrom('declaration').where('id', '=', d.id).executeTakeFirst())).rejects.toThrow(/permission denied/) // jamais de DELETE (preuve d'audit)
    await expect(withTenant(t, (trx) => trx.insertInto('analyse_cause').values({ entreprise_id: f.entrepriseA, declaration_id: d.id }).execute())).rejects.toThrow(/row-level security/)
    await expect(withTenant(t, (trx) => trx.insertInto('action_corrective').values({
      entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: d.id, libelle: 'x',
    }).execute())).rejects.toThrow(/row-level security/)
    await expect(withTenant(t, (trx) => trx.insertInto('historique_declaration').values({
      entreprise_id: f.entrepriseA, declaration_id: d.id, statut_avant: 'a_qualifier', statut_apres: 'a_qualifier', commentaire: 'x',
    }).execute())).rejects.toThrow(/row-level security/)
  })

  it('une déclaration inventée au nom d’une autre entreprise est rejetée', async () => {
    await expect(withTenant(A(declarant1), (trx) => trx.insertInto('declaration').values({
      entreprise_id: f.entrepriseB, reference: `X-${randomUUID().slice(0, 6)}`, type: 'presqu_accident', survenu_le: new Date(), description: 'x',
      declarant_id: declarant1,
    }).execute())).rejects.toThrow(/row-level security|n'appartient ni/)
  })
})

describe('Lecture par rôle et anonymat', () => {
  let nominative1: string
  let anonyme1: string
  let nominative2: string

  beforeAll(async () => {
    nominative1 = (await declarer(declarant1)).id
    anonyme1 = (await declarer(declarant1, { anonyme: true })).id
    nominative2 = (await declarer(declarant2)).id
  })

  it('un déclarant ne lit que ses déclarations non anonymes', async () => {
    const ids = (await lire(declarant1)).map((r) => r.id)
    expect(ids).toContain(nominative1)
    expect(ids).not.toContain(anonyme1) // même la sienne : l'anonymat vaut aussi pour son auteur
    expect(ids).not.toContain(nominative2)
    expect((await lire(declarant1)).every((r) => !r.anonyme)).toBe(true)
  })

  it('responsable QHSE, admin d’entreprise et consultant lisent tout ; l’autre entreprise rien', async () => {
    for (const u of [responsableQhse, f.utilisateurA1, f.consultantC1]) {
      const ids = (await lire(u)).map((r) => r.id)
      expect(ids).toEqual(expect.arrayContaining([nominative1, anonyme1, nominative2]))
    }
    const chezB = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => trx.selectFrom('declaration').select('id').execute())
    expect(chezB.map((r) => r.id)).not.toContain(nominative1)
  })

  it('historique, analyses et relances : lisibles par les responsables et l’équipe, jamais par un déclarant', async () => {
    const hist = (u: string) => withTenant(A(u), (trx) => trx.selectFrom('historique_declaration').select(['declaration_id', 'utilisateur_id']).execute())
    expect((await hist(declarant1)).length).toBe(0)
    const vu = await hist(responsableQhse)
    expect(vu.find((h) => h.declaration_id === anonyme1)?.utilisateur_id).toBeNull() // création anonyme sans auteur
    expect(vu.find((h) => h.declaration_id === nominative1)?.utilisateur_id).toBe(declarant1)
  })

  it('un déclarant joint une photo à sa déclaration anonyme tant qu’elle est à qualifier, sans pouvoir la relire', async () => {
    await withTenant(A(declarant1), (trx) => trx.insertInto('piece_jointe_declaration').values({ entreprise_id: f.entrepriseA, declaration_id: anonyme1, fichier_id: fichierA }).execute())
    const vues = await withTenant(A(declarant1), (trx) => trx.selectFrom('piece_jointe_declaration').select('id').where('declaration_id', '=', anonyme1).execute())
    expect(vues).toHaveLength(0)
    const vuesResp = await withTenant(A(responsableQhse), (trx) => trx.selectFrom('piece_jointe_declaration').select('id').where('declaration_id', '=', anonyme1).execute())
    expect(vuesResp).toHaveLength(1)
  })
})

describe('Responsable de site : déclarations, analyses et actions non anonymes de son site seulement (0037, 0040)', () => {
  it('voit les déclarations non anonymes de son site, jamais les anonymes, ni celles des autres sites ou sans site', async () => {
    const { siteX, siteY, responsableSiteX } = await migrate(async (c) => {
      const sx = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site X') RETURNING id", [f.entrepriseA])).rows[0].id
      const sy = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site Y') RETURNING id", [f.entrepriseA])).rows[0].id
      const u = await creerUtilisateur(c, 'respsite', 'responsable_site')
      await c.query("UPDATE role_utilisateur SET site_id = $1 WHERE utilisateur_id = $2", [sx, u])
      return { siteX: sx, siteY: sy, responsableSiteX: u }
    })
    const ids: Record<string, string> = {}
    for (const [nom, extra] of [
      ['nominative_x', { siteId: siteX }], ['anonyme_x', { siteId: siteX, anonyme: true }],
      ['nominative_y', { siteId: siteY }], ['sans_site', {}],
    ] as const) ids[nom] = (await declarer(declarant1, extra as Record<string, unknown>)).id
    const vues = (await lire(responsableSiteX)).map((r) => r.id)
    expect(vues).toContain(ids.nominative_x)
    expect(vues).not.toContain(ids.anonyme_x)
    expect(vues).not.toContain(ids.nominative_y)
    expect(vues).not.toContain(ids.sans_site)
    // Analyses et actions (0040) : celles de SES déclarations non anonymes seulement ; pas d'historique.
    const equipe = A(f.consultantC1)
    for (const nom of ['nominative_x', 'anonyme_x', 'nominative_y', 'sans_site']) {
      await withTenant(equipe, (trx) => trx.insertInto('analyse_cause').values({ entreprise_id: f.entrepriseA, declaration_id: ids[nom]!, methode: 'libre', etapes: JSON.stringify([{ texte: nom }]) as never }).execute())
      await withTenant(equipe, (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: ids[nom]!, libelle: nom }).execute())
    }
    const analyses = await withTenant(A(responsableSiteX), (trx) => trx.selectFrom('analyse_cause').select('declaration_id').execute())
    expect(analyses.map((r) => r.declaration_id)).toEqual([ids.nominative_x])
    const actions = await withTenant(A(responsableSiteX), (trx) => trx.selectFrom('action_corrective').select(['libelle', 'origine_type']).where('origine_type', '=', 'declaration').execute())
    expect(actions.map((r) => r.libelle)).toEqual(['nominative_x'])
    const hist = await withTenant(A(responsableSiteX), (trx) => trx.selectFrom('historique_declaration').select('id').execute())
    expect(hist).toHaveLength(0)
    // Lecture seule : ni écriture d'analyse, ni d'action.
    await expect(withTenant(A(responsableSiteX), (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: ids.nominative_x!, libelle: 'x' }).execute())).rejects.toThrow(/row-level security/)
    expect(nbModifiees(await withTenant(A(responsableSiteX), (trx) => trx.updateTable('analyse_cause').set({ methode: 'cinq_pourquoi' }).where('declaration_id', '=', ids.nominative_x!).executeTakeFirst()))).toBe(0)
    // Lecture seule : il ne qualifie pas.
    expect(nbModifiees(await withTenant(A(responsableSiteX), (trx) => trx.updateTable('declaration').set({ gravite: 1 }).where('id', '=', ids.nominative_x!).executeTakeFirst()))).toBe(0)
    // Un responsable d'un site d'une AUTRE entreprise (rôle sur le site X mais compte d'une autre entreprise) ne voit rien chez A.
    const chezB = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: responsableSiteX }, (trx) => trx.selectFrom('declaration').select('id').execute())
    expect(chezB).toHaveLength(0)
  })
})

describe('Références croisées entre entreprises', () => {
  it('site, salarié, fichier, preuve, origine d’action et comptes d’une autre entreprise sont refusés', async () => {
    const t = consultant()
    const d = await declarer(f.consultantC1)
    const ref = () => `X-${randomUUID().slice(0, 6)}`
    await expect(withTenant(t, (trx) => trx.insertInto('declaration').values({ entreprise_id: f.entrepriseA, reference: ref(), type: 'presqu_accident', survenu_le: new Date(), description: 'x', declarant_id: f.consultantC1, site_id: siteB }).execute())).rejects.toThrow(/foreign key|meme_entreprise/)
    await expect(withTenant(t, (trx) => trx.insertInto('declaration').values({ entreprise_id: f.entrepriseA, reference: ref(), type: 'presqu_accident', survenu_le: new Date(), description: 'x', declarant_id: f.consultantC1, salarie_id: f.salarieB1 }).execute())).rejects.toThrow(/foreign key|meme_entreprise/)
    await expect(withTenant(t, (trx) => trx.insertInto('piece_jointe_declaration').values({ entreprise_id: f.entrepriseA, declaration_id: d.id, fichier_id: fichierB }).execute())).rejects.toThrow(/foreign key|meme_entreprise/)
    await expect(withTenant(t, (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: ref(), origine_type: 'declaration', origine_id: declarationB, libelle: 'x' }).execute())).rejects.toThrow(/même entreprise/)
    await expect(withTenant(t, (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: ref(), origine_type: 'declaration', origine_id: d.id, libelle: 'x', preuve_id: fichierB }).execute())).rejects.toThrow(/foreign key|meme_entreprise/)
    // Compte d'une autre entreprise cliente : refusé ; compte IFECARM (consultant) : accepté.
    await expect(withTenant(t, (trx) => trx.insertInto('declaration').values({ entreprise_id: f.entrepriseA, reference: ref(), type: 'presqu_accident', survenu_le: new Date(), description: 'x', declarant_id: f.utilisateurB1 }).execute())).rejects.toThrow(/n'appartient ni/)
    await withTenant(t, (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: ref(), origine_type: 'declaration', origine_id: d.id, libelle: 'ok', responsable_id: f.consultantC1 }).execute())
  })
})

describe('Faits figés, statuts et historique tenu par la base', () => {
  const maj = (id: string, valeurs: Record<string, unknown>) =>
    withTenant(consultant(), (trx) => trx.updateTable('declaration').set(valeurs as never).where('id', '=', id).execute())

  it('anonymat, déclarant et référence ne changent jamais', async () => {
    const d = await declarer(declarant1, { anonyme: true })
    await expect(maj(d.id, { anonyme: false, declarant_id: declarant1 })).rejects.toThrow(/ne changent jamais/)
    await expect(maj(d.id, { reference: 'INC-1999-0001' })).rejects.toThrow(/ne changent jamais/)
  })

  it('qualification : gravité et fréquence requises, qualifieur posé par le serveur, faits figés ensuite, transitions contrôlées', async () => {
    const d = await declarer(declarant1)
    await maj(d.id, { description: 'corrigée avant qualification' }) // encore à qualifier : permis
    await expect(maj(d.id, { statut: 'en_analyse' })).rejects.toThrow(/Gravité et fréquence/)
    await expect(maj(d.id, { statut: 'cloturee', gravite: 2, frequence: 2 })).rejects.toThrow(/Transition/)
    await maj(d.id, { statut: 'en_analyse', gravite: 3, frequence: 2, qualifie_par: declarant1 })
    const apres = await withTenant(consultant(), (trx) => trx.selectFrom('declaration').select(['qualifie_par', 'criticite']).where('id', '=', d.id).executeTakeFirstOrThrow())
    expect(apres.qualifie_par).toBe(f.consultantC1) // la valeur envoyée par le client est ignorée
    expect(apres.criticite).toBe(6)
    await expect(maj(d.id, { description: 'réécrite après coup' })).rejects.toThrow(/figés après qualification/)
    await maj(d.id, { gravite: 4 }) // la qualification, elle, reste ajustable
    await expect(maj(d.id, { statut: 'a_qualifier' })).rejects.toThrow(/Transition/)

    const h = await withTenant(consultant(), (trx) => trx.selectFrom('historique_declaration').select(['statut_avant', 'statut_apres', 'utilisateur_id']).where('declaration_id', '=', d.id).orderBy('id').execute())
    expect(h.map((x) => `${x.statut_avant ?? '∅'}→${x.statut_apres}`)).toEqual(['∅→a_qualifier', 'a_qualifier→en_analyse'])
    expect(h[1]!.utilisateur_id).toBe(f.consultantC1)
  })

  it('commentaire d’historique : permis à l’équipe avec statut inchangé ; une ligne de changement de statut forgée est refusée', async () => {
    const d = await declarer(declarant1)
    await withTenant(consultant(), (trx) => trx.insertInto('historique_declaration').values({ entreprise_id: f.entrepriseA, declaration_id: d.id, utilisateur_id: f.consultantC1, statut_avant: 'a_qualifier', statut_apres: 'a_qualifier', commentaire: 'Précision du déclarant par téléphone' }).execute())
    await expect(withTenant(consultant(), (trx) => trx.insertInto('historique_declaration').values({ entreprise_id: f.entrepriseA, declaration_id: d.id, statut_avant: 'a_qualifier', statut_apres: 'cloturee', commentaire: 'forgé' }).execute())).rejects.toThrow(/row-level security/)
    await expect(withTenant(consultant(), (trx) => trx.updateTable('historique_declaration').set({ commentaire: 'réécrit' }).where('declaration_id', '=', d.id).executeTakeFirst())).rejects.toThrow(/permission denied/) // historique immuable
  })

  it('sans suite : motif requis ; clôture : actions ouvertes bloquantes ; déclaration close = figée', async () => {
    const s = await declarer(declarant1)
    await expect(maj(s.id, { statut: 'sans_suite' })).rejects.toThrow(/motif/i)
    await maj(s.id, { statut: 'sans_suite', motif_sans_suite: 'Doublon' })
    await expect(maj(s.id, { gravite: 1 })).rejects.toThrow(/figée/)

    const d = await declarer(declarant1)
    await maj(d.id, { statut: 'en_action', gravite: 2, frequence: 2 })
    const action = await withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: d.id, libelle: 'Corriger' }).returning('id').executeTakeFirstOrThrow())
    await expect(maj(d.id, { statut: 'cloturee' })).rejects.toThrow(/actions correctives restent ouvertes/)
    await withTenant(consultant(), (trx) => trx.updateTable('action_corrective').set({ statut: 'realisee', realisee_le: sql`current_date` }).where('id', '=', action.id).execute())
    await maj(d.id, { statut: 'cloturee' })
    await expect(maj(d.id, { statut: 'en_analyse' })).rejects.toThrow(/figée/)
    await expect(withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: d.id, libelle: 'tardive' }).execute())).rejects.toThrow(/aucune action/)
  })

  it('actions d’origine déclaration : réalisée sans date, vérifiée sans résultat, abandonnée sans motif refusées', async () => {
    const d = await declarer(declarant1)
    const nouvelle = () => ({ entreprise_id: f.entrepriseA, reference: `PA-${randomUUID().slice(0, 6)}`, origine_type: 'declaration', origine_id: d.id, libelle: 'x' })
    await expect(withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ ...nouvelle(), statut: 'realisee' }).execute())).rejects.toThrow(/réalisation/)
    await expect(withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ ...nouvelle(), statut: 'verifiee', realisee_le: sql`current_date` }).execute())).rejects.toThrow(/vérification/)
    await expect(withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ ...nouvelle(), statut: 'abandonnee' }).execute())).rejects.toThrow(/motif/)
    await withTenant(consultant(), (trx) => trx.insertInto('action_corrective').values({ ...nouvelle(), statut: 'verifiee', realisee_le: sql`current_date`, verifiee_par: f.consultantC1, verifiee_le: sql`current_date`, efficace: true }).execute())
  })

  it('lecture des actions : celles d’une déclaration sont cachées au déclarant, celles d’une inspection restent visibles du client', async () => {
    const lireActions = (u: string) => withTenant(A(u), (trx) => trx.selectFrom('action_corrective').select(['origine_type']).execute())
    expect((await lireActions(declarant1)).some((a) => a.origine_type === 'declaration')).toBe(false)
    expect((await lireActions(responsableQhse)).some((a) => a.origine_type === 'declaration')).toBe(true)
  })
})

describe('Rejeu hors ligne : référence rendue sans exposer le contenu', () => {
  it('un déclarant qui rejoue une déclaration anonyme récupère id et référence, jamais plus', async () => {
    const cleClient = randomUUID()
    const premier = await declarer(declarant1, { anonyme: true, cleClient })
    const rejeu = await declarer(declarant1, { anonyme: true, cleClient })
    expect(rejeu).toEqual(premier)
    const { rows } = await withTenant(A(declarant1), (trx) => sql<Record<string, unknown>>`select * from chercher_declaration_par_cle(${cleClient})`.execute(trx))
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'reference'])
    const ailleurs = await withTenant({ entrepriseId: f.entrepriseB, utilisateurId: f.utilisateurB1 }, (trx) => sql`select * from chercher_declaration_par_cle(${cleClient})`.execute(trx))
    expect(ailleurs.rows).toHaveLength(0)
  })
})
