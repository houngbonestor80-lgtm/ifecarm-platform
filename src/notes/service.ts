import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { ErreurMetier, texte, uuid } from '@/inspections/service'

/**
 * Notes internes sur les objets (migration 0042) : l'équipe IFECARM écrit une note libre sur une inspection,
 * une non-conformité, une action, une session de formation, un équipement ou une déclaration. Jamais visibles
 * du client (RLS). Auteur et nom posés par la base ; l'objet doit appartenir à l'entreprise active.
 */

export const TYPES_NOTE = ['inspection', 'non_conformite', 'action_corrective', 'session_formation', 'equipement', 'declaration'] as const
export type TypeNote = (typeof TYPES_NOTE)[number]

type Ctx = { entrepriseId: string, utilisateurId: string, estAdminPlateforme: boolean }

const typeNote = (v: unknown): TypeNote => {
  if (!TYPES_NOTE.includes(v as TypeNote)) throw new ErreurMetier(400, 'Type d’objet invalide.')
  return v as TypeNote
}

export async function listerNotes(trx: Transaction<DB>, ctx: Ctx, typeBrut: unknown, idBrut: unknown) {
  const type = typeNote(typeBrut)
  const id = uuid(idBrut, 'Objet')
  const notes = await trx.selectFrom('note_objet')
    .select(['id', 'auteur_id', 'auteur_nom', 'contenu', 'cree_le'])
    .where('objet_type', '=', type).where('objet_id', '=', id).orderBy('cree_le').execute()
  // La base refuse la suppression à tout autre que l'auteur et l'administrateur : on le dit à l'écran.
  return notes.map((n) => ({ id: n.id, auteur_nom: n.auteur_nom, contenu: n.contenu, cree_le: n.cree_le, supprimable: n.auteur_id === ctx.utilisateurId || ctx.estAdminPlateforme }))
}

export async function ajouterNote(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const type = typeNote(corps.objetType)
  const objetId = uuid(corps.objetId, 'Objet')
  const contenu = texte(corps.contenu, 'Note', 2000)
  try {
    const n = await trx.insertInto('note_objet')
      // auteur_id / auteur_nom sont réécrits par le déclencheur : valeurs de remplissage seulement.
      .values({ entreprise_id: ctx.entrepriseId, objet_type: type, objet_id: objetId, contenu, auteur_nom: '-' })
      .returning('id').executeTakeFirstOrThrow()
    // Jamais le contenu au journal (note interne) : le type d'objet suffit à la trace.
    await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'note_objet', objetId: n.id, details: { sur: type } })
    return n
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF404') throw new ErreurMetier(404, 'Objet introuvable.')
    if (code === '23514') throw new ErreurMetier(400, 'Note invalide (1 à 2 000 caractères).')
    throw e
  }
}

export async function supprimerNote(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown) {
  const id = uuid(idBrut, 'Note')
  const r = await trx.deleteFrom('note_objet').where('id', '=', id).executeTakeFirst()
  if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Note introuvable, ou réservée à son auteur.')
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'note_objet', objetId: id, details: null })
}
