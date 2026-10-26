import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withPlatformAdmin, withTenant, withoutTenant } from '@/db/tenant'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesFormations, nettoyerFixturesFormations, type FixturesFormations } from './fixtures-formations'

/**
 * Migration 0043 (B4) : habilitations. Droits (équipe écrit ; admin d'entreprise, responsable QHSE, responsable de
 * site lisent ; rien pour les autres), catalogue, références croisées, identité figée, statuts, renouvellement,
 * justificatif, état calculé, alertes. Toutes les assertions passent par ifecarm_app ; ifecarm_migrate prépare.
 */

let f: Fixtures
let ff: FixturesFormations
let declarant: string
let qhse: string
let respSite: string
let siteX: string
let salarieX: string          // salarié du site X
let salarieA2: string         // second salarié de A, sans site
let typeCatalogue: string
let typeA: string
let typeB: string
let consultantSansAcces: string

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const A = (utilisateurId: string) => ({ entrepriseId: f.entrepriseA, utilisateurId })
const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const code = () => `T${randomUUID().slice(0, 6).toUpperCase()}`
const nb = (r: { numUpdatedRows?: bigint, numDeletedRows?: bigint }) => Number(r.numUpdatedRows ?? r.numDeletedRows ?? 0)

const creer = (u: string, v: { salarie?: string, type?: string, niveau?: string | null, delivrance?: string, validite?: string | null, extra?: Record<string, unknown> } = {}) =>
  withTenant(A(u), (trx) => trx.insertInto('habilitation').values({
    entreprise_id: f.entrepriseA, salarie_id: v.salarie ?? f.salarieA1, type_id: v.type ?? typeA, niveau: v.niveau ?? null,
    date_delivrance: v.delivrance ?? jour(-300), date_validite: v.validite === undefined ? jour(200) : v.validite, ...v.extra,
  } as never).returning('id').executeTakeFirstOrThrow().then((r) => r.id))
const lire = (u: string, entreprise = f.entrepriseA) =>
  withTenant({ entrepriseId: entreprise, utilisateurId: u }, (trx) => trx.selectFrom('habilitation').select(['id', 'salarie_id']).execute())

async function creerUtilisateur(c: Client, label: string, role: string, site?: string): Promise<string> {
  const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, $3) RETURNING id', [f.entrepriseA, `${label}-${randomUUID().slice(0, 8)}@test.local`, label])
  await c.query('INSERT INTO role_utilisateur (utilisateur_id, role, site_id) VALUES ($1, $2, $3)', [u.id, role, site ?? null])
  return u.id
}

beforeAll(async () => {
  f = await creerFixtures()
  ff = await creerFixturesFormations(f)
  await migrate(async (c) => {
    siteX = (await c.query("INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site hab X') RETURNING id", [f.entrepriseA])).rows[0].id
    salarieX = (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom, site_id) VALUES ($1, 'Soudeur', 'Koffi', $2) RETURNING id", [f.entrepriseA, siteX])).rows[0].id
    salarieA2 = (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom) VALUES ($1, 'Magasinier', 'Afi') RETURNING id", [f.entrepriseA])).rows[0].id
    declarant = await creerUtilisateur(c, 'declarant', 'declarant')
    qhse = await creerUtilisateur(c, 'qhse', 'responsable_qhse')
    respSite = await creerUtilisateur(c, 'respsite', 'responsable_site', siteX)
    consultantSansAcces = f.consultantC1
    const t = async (entreprise: string | null, c1: string, intitule: string) =>
      (await c.query("INSERT INTO type_habilitation (entreprise_id, code, intitule, domaine, validite_mois) VALUES ($1, $2, $3, 'electrique', 36) RETURNING id", [entreprise, c1, intitule])).rows[0].id
    typeCatalogue = await t(null, code(), 'Habilitation électrique (catalogue test)')
    typeA = await t(f.entrepriseA, code(), 'Habilitation maison A')
    typeB = await t(f.entrepriseB, code(), 'Habilitation maison B')
  })
})

afterAll(async () => {
  try { await migrate((c) => c.query('DELETE FROM type_habilitation WHERE id = $1', [typeCatalogue])) } catch { /* catalogue de test */ }
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixturesFormations(ff) } catch { /* idem */ }
})

describe('Catalogue des types', () => {
  it('le catalogue et les types de son entreprise sont lisibles ; jamais ceux d’une autre', async () => {
    for (const u of [f.consultantC1, f.utilisateurA1, qhse, respSite, declarant]) {
      const ids = (await withTenant(A(u), (trx) => trx.selectFrom('type_habilitation').select('id').execute())).map((r) => r.id)
      expect(ids).toEqual(expect.arrayContaining([typeCatalogue, typeA]))
      expect(ids).not.toContain(typeB)
    }
  })

  it('le client ne crée ni ne modifie aucun type ; l’équipe crée ceux de son entreprise seulement', async () => {
    const valeurs = { code: code(), intitule: 'Type client', domaine: 'autre' }
    for (const u of [f.utilisateurA1, qhse, declarant]) {
      await expect(withTenant(A(u), (trx) => trx.insertInto('type_habilitation').values({ entreprise_id: f.entrepriseA, ...valeurs }).execute())).rejects.toThrow(/row-level security/)
    }
    await withTenant(A(f.consultantC1), (trx) => trx.insertInto('type_habilitation').values({ entreprise_id: f.entrepriseA, ...valeurs }).execute())
    await expect(withTenant(A(f.consultantC1), (trx) => trx.insertInto('type_habilitation').values({ entreprise_id: f.entrepriseB, ...valeurs, code: code() }).execute())).rejects.toThrow(/row-level security/)
    await expect(withTenant(A(f.consultantC1), (trx) => trx.insertInto('type_habilitation').values({ entreprise_id: null, ...valeurs, code: code() }).execute())).rejects.toThrow(/row-level security/)
    expect(nb(await withTenant(A(f.utilisateurA1), (trx) => trx.updateTable('type_habilitation').set({ intitule: 'x' }).where('id', '=', typeA).executeTakeFirst()))).toBe(0)
    expect(nb(await withTenant(A(f.consultantC1), (trx) => trx.updateTable('type_habilitation').set({ intitule: 'x' }).where('id', '=', typeCatalogue).executeTakeFirst()))).toBe(0) // catalogue : administrateur seul
  })

  it('l’administrateur gère le catalogue ; code unique (casse ignorée) ; un type client ne reprend pas un code du catalogue', async () => {
    const c1 = code()
    await withPlatformAdmin({ utilisateurId: f.adminPlateformeP1, operation: 'gerer_catalogue_habilitation' }, (trx) =>
      trx.insertInto('type_habilitation').values({ entreprise_id: null, code: c1, intitule: 'Ajout catalogue', domaine: 'hauteur' }).execute())
    await expect(withPlatformAdmin({ utilisateurId: f.adminPlateformeP1, operation: 'gerer_catalogue_habilitation' }, (trx) =>
      trx.insertInto('type_habilitation').values({ entreprise_id: null, code: c1.toLowerCase(), intitule: 'Doublon', domaine: 'hauteur' }).execute())).rejects.toThrow(/uq_type_habilitation_catalogue|duplicate/)
    await expect(withTenant(A(f.consultantC1), (trx) => trx.insertInto('type_habilitation').values({ entreprise_id: f.entrepriseA, code: c1.toLowerCase(), intitule: 'Même code', domaine: 'autre' }).execute())).rejects.toThrow(/existe déjà dans le catalogue/)
    await migrate((c) => c.query('DELETE FROM type_habilitation WHERE code = $1', [c1]))
  })

  it('un type inactif ne sert plus à créer une habilitation', async () => {
    const inactif = await migrate(async (c) => (await c.query("INSERT INTO type_habilitation (entreprise_id, code, intitule, domaine, actif) VALUES ($1, $2, 'Type inactif', 'autre', false) RETURNING id", [f.entrepriseA, code()])).rows[0].id)
    await expect(creer(f.consultantC1, { type: inactif })).rejects.toThrow(/inactif/)
  })
})

describe('Droits sur les habilitations', () => {
  let hX: string
  let hA: string

  beforeAll(async () => {
    hA = await creer(f.consultantC1, { salarie: f.salarieA1, type: typeCatalogue })
    hX = await creer(f.consultantC1, { salarie: salarieX, type: typeCatalogue })
  })

  it('l’équipe crée ; l’auteur est posé par le serveur', async () => {
    const auteur = await migrate(async (c) => (await c.query('SELECT cree_par FROM habilitation WHERE id = $1', [hA])).rows[0].cree_par)
    expect(auteur).toBe(f.consultantC1)
  })

  it('lecture : équipe, admin d’entreprise et responsable QHSE voient tout ; le responsable de site, les seuls salariés de son site ; le déclarant rien ; l’autre entreprise rien', async () => {
    for (const u of [f.consultantC1, f.utilisateurA1, qhse]) expect((await lire(u)).map((r) => r.id)).toEqual(expect.arrayContaining([hA, hX]))
    expect((await lire(respSite)).map((r) => r.id)).toEqual([hX])
    expect(await lire(declarant)).toEqual([])
    expect(await lire(f.utilisateurB1, f.entrepriseB)).toEqual([])
  })

  it('aucun utilisateur du client n’écrit : insertion refusée, modification et suppression sans effet', async () => {
    for (const u of [f.utilisateurA1, qhse, respSite, declarant]) {
      await expect(creer(u)).rejects.toThrow(/row-level security/)
      expect(nb(await withTenant(A(u), (trx) => trx.updateTable('habilitation').set({ commentaire: 'x' }).where('id', '=', hX).executeTakeFirst()))).toBe(0)
      expect(nb(await withTenant(A(u), (trx) => trx.deleteFrom('habilitation').where('id', '=', hX).executeTakeFirst()))).toBe(0)
    }
  })

  it('une habilitation inventée au nom d’une autre entreprise est rejetée', async () => {
    await expect(withTenant(A(f.consultantC1), (trx) => trx.insertInto('habilitation').values({ entreprise_id: f.entrepriseB, salarie_id: f.salarieB1, type_id: typeCatalogue, date_delivrance: jour(-10) }).execute())).rejects.toThrow(/row-level security/)
  })

  it('état calculé : la vue ne rend rien au déclarant (security_invoker) ; l’équipe lit l’état', async () => {
    expect(await withTenant(A(declarant), (trx) => trx.selectFrom('v_habilitation_etat').select('id').execute())).toEqual([])
    const e = await withTenant(A(f.consultantC1), (trx) => trx.selectFrom('v_habilitation_etat').select(['etat', 'jours_restants']).where('id', '=', hA).executeTakeFirstOrThrow())
    expect(e.etat).toBe('valide')
    expect(Number(e.jours_restants)).toBe(200)
  })
})

describe('État calculé', () => {
  it('valide, à renouveler (90 jours), expirée, et les statuts saisis l’emportent', async () => {
    const etat = async (statut: string, validite: string | null) =>
      (await withoutTenant((trx) => sql<{ e: string }>`select etat_habilitation(${statut}, ${validite}::date) as e`.execute(trx))).rows[0]!.e
    expect(await etat('active', null)).toBe('valide')
    expect(await etat('active', jour(400))).toBe('valide')
    expect(await etat('active', jour(91))).toBe('valide')
    expect(await etat('active', jour(90))).toBe('a_renouveler')
    expect(await etat('active', jour(0))).toBe('a_renouveler')
    expect(await etat('active', jour(-1))).toBe('expiree')
    expect(await etat('suspendue', jour(-500))).toBe('suspendue')
    expect(await etat('retiree', jour(500))).toBe('retiree')
  })
})

describe('Références croisées entre entreprises', () => {
  it('salarié ou type d’une autre entreprise : refusé ; type du catalogue : accepté', async () => {
    await expect(creer(f.consultantC1, { salarie: f.salarieB1 })).rejects.toThrow(/foreign key|salarie/i)
    await expect(creer(f.consultantC1, { type: typeB })).rejects.toThrow(/autre entreprise/)
    expect(await creer(f.consultantC1, { salarie: salarieA2, type: typeCatalogue })).toBeTruthy()
  })

  it('attestation B2 : valide et délivrée au MÊME salarié, sinon refusée ; justificatif impossible à la création', async () => {
    // attestationA appartient au participant de salarieA1 (fixtures B2).
    await expect(creer(f.consultantC1, { salarie: salarieX, type: typeCatalogue, extra: { attestation_id: ff.attestationA } })).rejects.toThrow(/délivrée à ce salarié/)
    await expect(creer(f.consultantC1, { salarie: f.salarieA1, type: typeA, extra: { attestation_id: ff.attestationB } })).rejects.toThrow() // attestation de l'entreprise B
    const id = await creer(f.consultantC1, { salarie: f.salarieA1, type: typeA, niveau: 'avec attestation', extra: { attestation_id: ff.attestationA } })
    expect(id).toBeTruthy()
    await expect(creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'avec fichier', extra: { fichier_id: randomUUID() } })).rejects.toThrow(/après la création/)
  })

  it('justificatif : un fichier rattaché à CETTE habilitation seulement', async () => {
    const h = await creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'justificatif' })
    const h2 = await creer(f.consultantC1, { salarie: salarieX, type: typeA, niveau: 'justificatif' })
    const fich = await withTenant(A(f.consultantC1), async (trx) => {
      const idF = randomUUID()
      await trx.insertInto('fichier').values({ id: idF, entreprise_id: f.entrepriseA, cle_stockage: `hab/${idF}`, nom_origine: 'titre.pdf', objet_type: 'habilitation', objet_id: h2 }).execute()
      return idF
    })
    await expect(withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set({ fichier_id: fich }).where('id', '=', h).execute())).rejects.toThrow(/rattaché à cette habilitation/)
    await withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set({ fichier_id: fich }).where('id', '=', h2).execute())
  })
})

describe('Fichiers justificatifs : visibilité = visibilité de l’habilitation', () => {
  it('le déclarant et le responsable de site d’un autre site ne lisent pas ; le responsable QHSE oui ; l’administrateur plateforme jamais', async () => {
    const h = await creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'fichier visible' })
    const idF = randomUUID()
    await withTenant(A(f.consultantC1), (trx) => trx.insertInto('fichier').values({ id: idF, entreprise_id: f.entrepriseA, cle_stockage: `hab/${idF}`, nom_origine: 'titre.pdf', objet_type: 'habilitation', objet_id: h }).execute())
    const vu = (u: string) => withTenant(A(u), (trx) => trx.selectFrom('fichier').select('id').where('id', '=', idF).execute())
    expect(await vu(f.consultantC1)).toHaveLength(1)
    expect(await vu(qhse)).toHaveLength(1)
    expect(await vu(declarant)).toHaveLength(0)
    expect(await vu(respSite)).toHaveLength(0) // salarié sans site : hors de son périmètre
    const parAdmin = await withPlatformAdmin({ utilisateurId: f.adminPlateformeP1, operation: 'lister_entreprises' }, (trx) => trx.selectFrom('fichier').select('id').where('id', '=', idF).execute())
    expect(parAdmin).toHaveLength(0)
    // Écriture : jamais le client.
    await expect(withTenant(A(declarant), (trx) => trx.insertInto('fichier').values({ entreprise_id: f.entrepriseA, cle_stockage: `hab/${randomUUID()}`, nom_origine: 'x', objet_type: 'habilitation', objet_id: h }).execute())).rejects.toThrow(/row-level security/)
    expect(nb(await withTenant(A(qhse), (trx) => trx.deleteFrom('fichier').where('id', '=', idF).executeTakeFirst()))).toBe(0)
  })
})

describe('Identité figée et statuts', () => {
  it('salarié, type et création ne changent jamais ; dates cohérentes', async () => {
    const h = await creer(f.consultantC1, { salarie: salarieA2, type: typeCatalogue, niveau: 'figee' })
    const maj = (v: Record<string, unknown>) => withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set(v as never).where('id', '=', h).execute())
    await expect(maj({ salarie_id: f.salarieA1 })).rejects.toThrow(/ne changent jamais/)
    await expect(maj({ type_id: typeA })).rejects.toThrow(/ne changent jamais/)
    await expect(maj({ cree_le: new Date('2000-01-01') })).rejects.toThrow(/ne changent jamais/)
    await expect(maj({ date_validite: jour(-1000) })).rejects.toThrow(/check|date_validite/i)
    await maj({ reference_titre: 'B2V-2024-118', delivre_par: 'Organisme X', commentaire: 'Titre corrigé' }) // les faits restent corrigeables tant que le titre est en cours
  })

  it('suspension et retrait exigent un motif ; transitions contrôlées ; « retirée » est définitive', async () => {
    const h = await creer(f.consultantC1, { salarie: salarieA2, type: typeCatalogue, niveau: 'statuts' })
    const maj = (v: Record<string, unknown>) => withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set(v as never).where('id', '=', h).execute())
    await expect(maj({ statut: 'suspendue' })).rejects.toThrow(/check|motif/i)
    await maj({ statut: 'suspendue', motif: 'Visite médicale en attente' })
    await maj({ statut: 'active' })
    const apres = await migrate(async (c) => (await c.query('SELECT motif FROM habilitation WHERE id = $1', [h])).rows[0])
    expect(apres.motif).toBeNull() // le motif disparaît à la réactivation
    await expect(maj({ statut: 'retiree' })).rejects.toThrow(/check|motif/i)
    await maj({ statut: 'retiree', motif: 'Saisie par erreur' })
    await expect(maj({ statut: 'active' })).rejects.toThrow(/figée/)
    await expect(maj({ commentaire: 'tardif' })).rejects.toThrow(/figée/)
  })
})

describe('Renouvellement', () => {
  const renouveler = (ancien: string, salarie: string, type: string, niveau: string | null, marquer = true) =>
    withTenant(A(f.consultantC1), async (trx) => {
      if (marquer) await trx.updateTable('habilitation').set({ statut: 'remplacee' }).where('id', '=', ancien).execute()
      return trx.insertInto('habilitation').values({ entreprise_id: f.entrepriseA, salarie_id: salarie, type_id: type, niveau, date_delivrance: jour(-5), date_validite: jour(900), renouvelle_id: ancien } as never).returning('id').executeTakeFirstOrThrow().then((r) => r.id)
    })

  it('l’ancien titre est marqué « remplacée » et le nouveau le référence, dans la même transaction ; l’historique reste', async () => {
    const ancien = await creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'renouvelable', validite: jour(10) })
    const nouveau = await renouveler(ancien, salarieA2, typeA, 'renouvelable')
    const lignes = await migrate(async (c) => (await c.query('SELECT id, statut, renouvelle_id FROM habilitation WHERE id = ANY($1)', [[ancien, nouveau]])).rows)
    expect(lignes.find((l) => l.id === ancien)!.statut).toBe('remplacee')
    expect(lignes.find((l) => l.id === nouveau)).toMatchObject({ statut: 'active', renouvelle_id: ancien })
    await expect(withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set({ commentaire: 'x' }).where('id', '=', ancien).execute())).rejects.toThrow(/figée/)
  })

  it('refusé : titre précédent non marqué, autre type, remplacement sans successeur, suppression du seul successeur', async () => {
    const ancien = await creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'cas-limites' })
    await expect(renouveler(ancien, salarieA2, typeA, 'cas-limites', false)).rejects.toThrow(/d'abord être marqué|doit d.abord/i)
    await expect(withTenant(A(f.consultantC1), async (trx) => {
      await trx.updateTable('habilitation').set({ statut: 'remplacee' }).where('id', '=', ancien).execute()
      await trx.insertInto('habilitation').values({ entreprise_id: f.entrepriseA, salarie_id: salarieA2, type_id: typeCatalogue, date_delivrance: jour(-1), renouvelle_id: ancien } as never).execute()
    })).rejects.toThrow(/même salarié et le même type/)
    // « remplacee » seul : la transaction échoue à la validation.
    await expect(withTenant(A(f.consultantC1), (trx) => trx.updateTable('habilitation').set({ statut: 'remplacee' }).where('id', '=', ancien).execute())).rejects.toThrow(/titre qui la remplace/)
    // Supprimer le seul successeur d'un titre remplacé : refusé ; supprimer les deux : accepté.
    const ancien2 = await creer(f.consultantC1, { salarie: salarieA2, type: typeA, niveau: 'suppression' })
    const nouveau2 = await renouveler(ancien2, salarieA2, typeA, 'suppression')
    await expect(withTenant(A(f.consultantC1), (trx) => trx.deleteFrom('habilitation').where('id', '=', nouveau2).execute())).rejects.toThrow(/titre qui la remplace/)
    await withTenant(A(f.consultantC1), async (trx) => {
      await trx.deleteFrom('habilitation').where('id', '=', nouveau2).execute()
      await trx.deleteFrom('habilitation').where('id', '=', ancien2).execute()
    })
  })

  it('un seul titre en cours par salarié, type et niveau ; un autre niveau est permis', async () => {
    await creer(f.consultantC1, { salarie: salarieX, type: typeA, niveau: 'B2V' })
    await expect(creer(f.consultantC1, { salarie: salarieX, type: typeA, niveau: ' b2v ' })).rejects.toThrow(/uq_habilitation_en_cours|duplicate/)
    expect(await creer(f.consultantC1, { salarie: salarieX, type: typeA, niveau: 'BR' })).toBeTruthy()
  })
})

describe('Suppressions en cascade et références qui disparaissent', () => {
  it('supprimer une attestation, un compte ou un salarié ne bloque jamais, même sur un titre figé', async () => {
    // Un consultant éphémère crée le titre ; on le retire ; la suppression du compte met cree_par à NULL sans bloquer.
    const compte = await migrate(async (c) => {
      const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, $3) RETURNING id', [f.ifecarmInterne, `eph-${randomUUID().slice(0, 8)}@test.local`, 'Éphémère'])
      await c.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'consultant_ifecarm')", [u.id])
      return u.id as string
    })
    const h = await creer(compte, { salarie: salarieA2, type: typeCatalogue, niveau: 'cascade' })
    expect((await migrate(async (c) => (await c.query('SELECT cree_par FROM habilitation WHERE id = $1', [h])).rows[0])).cree_par).toBe(compte)
    await migrate((c) => c.query("UPDATE habilitation SET statut = 'retiree', motif = 'test' WHERE id = $1", [h]))
    await migrate((c) => c.query('DELETE FROM utilisateur WHERE id = $1', [compte])) // cree_par → NULL sur un titre retiré
    expect((await migrate(async (c) => (await c.query('SELECT cree_par FROM habilitation WHERE id = $1', [h])).rows[0])).cree_par).toBeNull()

    const sal = await migrate(async (c) => (await c.query("INSERT INTO salarie (entreprise_id, nom, prenom) VALUES ($1, 'Partant', 'Test') RETURNING id", [f.entrepriseA])).rows[0].id)
    const anc = await creer(f.consultantC1, { salarie: sal, type: typeA, niveau: 'cascade-salarie' })
    await withTenant(A(f.consultantC1), async (trx) => {
      await trx.updateTable('habilitation').set({ statut: 'remplacee' }).where('id', '=', anc).execute()
      await trx.insertInto('habilitation').values({ entreprise_id: f.entrepriseA, salarie_id: sal, type_id: typeA, niveau: 'cascade-salarie', date_delivrance: jour(-1), renouvelle_id: anc } as never).execute()
    })
    await migrate((c) => c.query('DELETE FROM salarie WHERE id = $1', [sal])) // emporte l'ancien et le nouveau titre
    expect(Number((await migrate((c) => c.query('SELECT count(*) FROM habilitation WHERE salarie_id = $1', [sal]))).rows[0].count)).toBe(0)

    // Une attestation supprimée (0034) ne supprime pas l'habilitation qui la citait, même retirée : le lien passe à NULL.
    const liee = await migrate(async (c) => (await c.query("SELECT id FROM habilitation WHERE attestation_id = $1 LIMIT 1", [ff.attestationA])).rows[0]?.id as string | undefined)
    expect(liee).toBeTruthy()
    await migrate((c) => c.query("UPDATE habilitation SET statut = 'retiree', motif = 'test' WHERE id = $1", [liee]))
    await migrate((c) => c.query('DELETE FROM attestation WHERE id = $1', [ff.attestationA]))
    expect((await migrate(async (c) => (await c.query('SELECT attestation_id FROM habilitation WHERE id = $1', [liee])).rows[0])).attestation_id).toBeNull()
  })
})

describe('Alertes de renouvellement', () => {
  const alerter = (entreprise: string) => withoutTenant(async (trx) => Number((await sql<{ n: number }>`select alerter_habilitations(${entreprise}::uuid) as n`.execute(trx)).rows[0]!.n))
  const jalons = () => migrate(async (c) => Object.fromEntries((await c.query(
    `SELECT h.niveau, al.jalon_jours FROM alerte_habilitation al JOIN habilitation h ON h.id = al.habilitation_id WHERE al.entreprise_id = $1 AND h.niveau LIKE 'al-%'`, [f.entrepriseA])).rows.map((r) => [r.niveau, r.jalon_jours])))
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    // Un salarié du site X (le responsable de site doit être prévenu) et un sans site.
    const sans = salarieA2
    const mk = async (niveau: string, salarie: string, validite: string | null, extra: Record<string, unknown> = {}) => { ids[niveau] = await creer(f.consultantC1, { salarie, type: typeA, niveau, validite, extra }) }
    await mk('al-lointaine', sans, jour(150))
    await mk('al-90', sans, jour(60))
    await mk('al-30', salarieX, jour(20))
    await mk('al-7', sans, jour(5))
    await mk('al-0', sans, jour(-3))
    await mk('al-sans-echeance', sans, null)
    await mk('al-suspendue', sans, jour(10))
    await mk('al-sortie', sans, jour(150))
    await migrate(async (c) => {
      await c.query("UPDATE habilitation SET statut = 'suspendue', motif = 'x' WHERE id = $1", [ids['al-suspendue']])
    })
  })

  it('un jalon par habilitation, le plus avancé atteint ; rien pour les titres lointains, sans échéance ou suspendus', async () => {
    expect(await alerter(f.entrepriseA)).toBe(4)
    expect(await jalons()).toEqual({ 'al-90': 90, 'al-30': 30, 'al-7': 7, 'al-0': 0 })
  })

  it('idempotent, puis escalade au jalon suivant', async () => {
    expect(await alerter(f.entrepriseA)).toBe(0)
    await migrate((c) => c.query('UPDATE habilitation SET date_validite = current_date + 25 WHERE id = $1', [ids['al-90']]))
    expect(await alerter(f.entrepriseA)).toBe(1)
    expect(await alerter(f.entrepriseA)).toBe(0)
  })

  it('destinataires : admin d’entreprise, responsable QHSE et responsable du site du salarié ; jamais le déclarant ; contenu sans donnée inutile', async () => {
    const lignes = await migrate(async (c) => (await c.query(
      "SELECT destinataire, sujet, corps, module FROM notification WHERE entreprise_id = $1 AND module = 'habilitations' AND corps LIKE '%Soudeur%'", [f.entrepriseA])).rows)
    const dest = lignes.map((l) => l.destinataire as string)
    expect(lignes.length).toBeGreaterThanOrEqual(3)
    expect(new Set(dest).size).toBe(dest.length)
    const emails = await migrate(async (c) => Object.fromEntries((await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.utilisateurA1, qhse, respSite, declarant]])).rows.map((r) => [r.id, r.email])))
    expect(dest).toEqual(expect.arrayContaining([emails[f.utilisateurA1], emails[qhse], emails[respSite]]))
    expect(dest).not.toContain(emails[declarant])
    expect(lignes[0].sujet).toMatch(/^Habilitation à renouveler — Koffi Soudeur/)
    // Le responsable de site n'est prévenu que pour les salariés de SON site.
    const horsSite = await migrate(async (c) => (await c.query("SELECT destinataire FROM notification WHERE entreprise_id = $1 AND module = 'habilitations' AND corps LIKE '%Magasinier%'", [f.entrepriseA])).rows.map((r) => r.destinataire))
    expect(horsSite).not.toContain(emails[respSite])
  })

  it('salarié sorti, entreprise désactivée, autre entreprise : aucune alerte', async () => {
    await migrate((c) => c.query("UPDATE salarie SET date_sortie = current_date - 1 WHERE id = $1", [salarieA2]))
    const avant = await migrate(async (c) => Number((await c.query('SELECT count(*) FROM alerte_habilitation WHERE entreprise_id = $1', [f.entrepriseA])).rows[0].count))
    await migrate((c) => c.query("UPDATE habilitation SET date_validite = current_date + 1 WHERE id = $1", [ids['al-sortie']]))
    expect(await alerter(f.entrepriseA)).toBe(0) // les titres de la salariée sortie sont ignorés
    const apres = await migrate(async (c) => Number((await c.query('SELECT count(*) FROM alerte_habilitation WHERE entreprise_id = $1', [f.entrepriseA])).rows[0].count))
    expect(apres).toBe(avant)
    expect(await alerter(f.entrepriseB)).toBe(0)
    await migrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseA]))
    expect(await alerter(f.entrepriseA)).toBe(0)
  })

  it('le client ne lit les alertes que s’il est responsable', async () => {
    await migrate((c) => c.query('UPDATE entreprise SET desactive_le = NULL WHERE id = $1', [f.entrepriseA]))
    const vues = (u: string) => withTenant(A(u), (trx) => trx.selectFrom('alerte_habilitation').select('id').execute())
    expect((await vues(f.utilisateurA1)).length).toBeGreaterThan(0)
    expect((await vues(qhse)).length).toBeGreaterThan(0)
    expect(await vues(declarant)).toHaveLength(0)
    expect(await vues(respSite)).toHaveLength(0)
  })
})
