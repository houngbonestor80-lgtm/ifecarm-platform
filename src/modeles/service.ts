import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurMetier, texte, texteOptionnel, uuid, type Gravite } from '@/inspections/service'

/**
 * Modèles d'inspection : catalogue IFECARM (entreprise_id NULL) et modèles
 * propres à l'entreprise active. Les fonctions ne décident d'aucun droit :
 * c'est le contexte de la transaction (tenant ou platform_admin) et la RLS de
 * 0008 qui bornent ce qui est lisible et modifiable ; les routes choisissent
 * le contexte selon la portée du modèle.
 */

export type Portee = 'catalogue' | 'entreprise'

export async function listerModeles(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string, intitule: string, domaine: string, cible_type: string, description: string | null,
    actif: boolean, portee: Portee, nb_items: number, inspections: number,
  }>`
    select m.id, m.intitule, m.domaine, m.cible_type, m.description, m.actif,
           case when m.entreprise_id is null then 'catalogue' else 'entreprise' end as portee,
           (select count(*) from item_modele_inspection im where im.modele_id = m.id)::int as nb_items,
           (select count(*) from inspection i where i.modele_id = m.id)::int as inspections
    from modele_inspection m
    order by (m.entreprise_id is null), m.actif desc, m.domaine, m.intitule
  `.execute(trx)
  return rows
}

export async function obtenirModele(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Modèle')
  const m = await trx.selectFrom('modele_inspection')
    .select(['id', 'intitule', 'domaine', 'cible_type', 'description', 'actif', 'entreprise_id'])
    .where('id', '=', id).executeTakeFirst()
  if (!m) throw new ErreurMetier(404, 'Modèle introuvable.')
  const items = await trx.selectFrom('item_modele_inspection')
    .select(['libelle', 'aide', 'gravite_defaut']).where('modele_id', '=', id).orderBy('ordre').execute()
  const { entreprise_id, ...reste } = m
  return { ...reste, portee: (entreprise_id ? 'entreprise' : 'catalogue') as Portee, items }
}

interface ItemSaisi { libelle: string, aide: string | null, gravite_defaut: Gravite }

function valider(corps: Record<string, unknown>) {
  if (corps.cibleType !== 'site' && corps.cibleType !== 'equipement') throw new ErreurMetier(400, 'Type de cible invalide.')
  if (!Array.isArray(corps.items) || corps.items.length === 0) throw new ErreurMetier(400, 'Au moins un point de contrôle est requis.')
  if (corps.items.length > 150) throw new ErreurMetier(400, '150 points de contrôle au maximum.')
  const items: ItemSaisi[] = corps.items.map((it: unknown, i) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
    const g = o.gravite ?? 'mineure'
    if (g !== 'mineure' && g !== 'majeure' && g !== 'critique') throw new ErreurMetier(400, `Point ${i + 1} : gravité invalide.`)
    return { libelle: texte(o.libelle, `Point ${i + 1}`, 500), aide: texteOptionnel(o.aide, `Consigne du point ${i + 1}`, 1000), gravite_defaut: g }
  })
  return {
    intitule: texte(corps.intitule, 'Intitulé', 200),
    domaine: texte(corps.domaine, 'Domaine', 80),
    cible_type: corps.cibleType as 'site' | 'equipement',
    description: texteOptionnel(corps.description, 'Description', 2000),
    items,
  }
}

const slug = (intitule: string) =>
  `${intitule.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${randomBytes(3).toString('hex')}`

async function remplacerItems(trx: Transaction<DB>, modeleId: string, items: ItemSaisi[]) {
  // Les inspections existantes gardent leurs libellés figés (item_modele_id passe à NULL).
  await trx.deleteFrom('item_modele_inspection').where('modele_id', '=', modeleId).execute()
  await trx.insertInto('item_modele_inspection')
    .values(items.map((it, i) => ({ modele_id: modeleId, ordre: i + 1, ...it })))
    .execute()
}

/** entrepriseId null = modèle du catalogue (contexte platform_admin requis par la RLS). */
export async function creerModele(trx: Transaction<DB>, entrepriseId: string | null, corps: Record<string, unknown>) {
  const { items, ...m } = valider(corps)
  const { id } = await trx.insertInto('modele_inspection')
    .values({ ...m, entreprise_id: entrepriseId, slug: slug(m.intitule) })
    .returning('id').executeTakeFirstOrThrow()
  await remplacerItems(trx, id, items)
  return { id }
}

export async function modifierModele(trx: Transaction<DB>, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Modèle')
  const { items, ...m } = valider(corps)
  const r = await trx.updateTable('modele_inspection')
    .set({ ...m, ...(typeof corps.actif === 'boolean' ? { actif: corps.actif } : {}) })
    .where('id', '=', id).executeTakeFirst()
  if (!r.numUpdatedRows) throw new ErreurMetier(404, 'Modèle introuvable ou non modifiable.')
  await remplacerItems(trx, id, items)
}

export async function supprimerModele(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Modèle')
  try {
    const r = await trx.deleteFrom('modele_inspection').where('id', '=', id).executeTakeFirst()
    if (!r.numDeletedRows) throw new ErreurMetier(404, 'Modèle introuvable ou non modifiable.')
  } catch (e) {
    if ((e as { code?: string }).code === '23503') {
      throw new ErreurMetier(409, 'Ce modèle a déjà servi à des inspections : archivez-le plutôt que de le supprimer.')
    }
    throw e
  }
}
