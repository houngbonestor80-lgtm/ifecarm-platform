import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurMetier } from '@/inspections/service'

/**
 * Opportunités de vente (migration 0053) : échéances des clients (recyclages, habilitations, vérifications d'équipements)
 * regroupées par entreprise et par objet, pour l'équipe IFECARM. Calculées en base à chaque lecture ; seul le suivi est
 * stocké. À appeler sous withAuthenticatedUser : la base revérifie que l'appelant est consultant ou admin et borne son
 * périmètre (mandats en cours du consultant, tous les clients pour l'admin).
 */

export type TypeOpportunite = 'recyclage' | 'habilitation' | 'verification'
export type StatutSuivi = 'contacte' | 'gagne' | 'perdu' | 'plus_tard'

export interface Opportunite {
  entreprise_id: string, entreprise_nom: string, statut_relation: string, pays: string
  contact_nom: string | null, contact_telephone: string | null, contact_email: string | null
  type: TypeOpportunite, cle: string, libelle: string, nb: number, premiere_echeance: string, derniere_echeance: string, echues: number
  suivi_statut: StatutSuivi | null, suivi_le: Date | null, suivi_par: string | null, suivi_note: string | null
}

const codeErreur = (e: unknown) => (e as { code?: string }).code

export async function listerOpportunites(trx: Transaction<DB>, horizon: unknown = 90): Promise<Opportunite[]> {
  const h = Number(horizon)
  try {
    return (await sql<Opportunite>`
      select entreprise_id, entreprise_nom, statut_relation, pays, contact_nom, contact_telephone, contact_email, type, cle, libelle, nb,
             to_char(premiere_echeance, 'YYYY-MM-DD') as premiere_echeance, to_char(derniere_echeance, 'YYYY-MM-DD') as derniere_echeance,
             echues, suivi_statut, suivi_le, suivi_par, suivi_note
      from opportunites_vente(${Number.isInteger(h) ? h : 90})`.execute(trx)).rows
  } catch (e) {
    if (codeErreur(e) === 'IF409') throw new ErreurMetier(400, (e as Error).message)
    throw e
  }
}

/** Corps : { entrepriseId, type, cle, statut, note? }. */
export async function suivreOpportunite(trx: Transaction<DB>, corps: Record<string, unknown>): Promise<void> {
  const texte = (v: unknown) => (typeof v === 'string' ? v : '')
  if (!/^[0-9a-f-]{36}$/i.test(texte(corps.entrepriseId))) throw new ErreurMetier(400, 'Entreprise invalide.')
  try {
    await sql`select suivre_opportunite(${texte(corps.entrepriseId)}::uuid, ${texte(corps.type)}, ${texte(corps.cle)}, ${texte(corps.statut)},
                                        ${typeof corps.note === 'string' ? corps.note : null})`.execute(trx)
  } catch (e) {
    if (codeErreur(e) === 'IF404') throw new ErreurMetier(404, 'Opportunité introuvable.')
    if (codeErreur(e) === 'IF409' || codeErreur(e) === 'IF403') throw new ErreurMetier(409, (e as Error).message)
    throw e
  }
}
