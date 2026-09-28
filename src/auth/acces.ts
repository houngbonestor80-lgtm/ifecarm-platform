import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

/**
 * Accès d'un consultant IFECARM à une entreprise cliente ou prospect.
 *
 * La RLS ne connaît que app.entreprise_id : c'est le CODE SERVEUR qui décide
 * dans quelle entreprise un utilisateur a le droit d'entrer avant d'appeler
 * withTenant. Pour un consultant, cette décision repose sur acces_consultant
 * — c'est ce contrôle-ci, à appeler AVANT withTenant, qui fait qu'un mandat
 * terminé (fin_le dépassée) ou une entreprise désactivée ne donne plus rien, et
 * qu'un accès en lecture seule (ecriture = false) n'autorise pas d'écrire.
 *
 * ⚠️ OBLIGATOIRE : toute route ou Server Action qui touche aux données d'une
 * entreprise cliente ou prospect au nom d'un CONSULTANT doit appeler
 * exigerAccesConsultant AVANT withTenant. La RLS ne peut pas le faire à sa
 * place. Voir src/app/api/inspections/LISEZ-MOI.md et tests/acces.test.ts.
 *
 * À appeler sous withAuthenticatedUser(utilisateurId) : la politique de
 * acces_consultant laisse chaque consultant lire SES propres accès.
 * (Un utilisateur d'une entreprise cliente entre dans sa propre entreprise :
 * cette information vient de sa session, pas de cette table.)
 */
export interface AccesConsultant {
  entrepriseId: string
  ecriture: boolean
  /** null = sans échéance. */
  finLe: Date | null
}

/** L'accès valide du consultant à cette entreprise, ou null (aucun accès, ou accès expiré). */
export async function accesConsultantValide(
  trx: Transaction<DB>,
  params: { utilisateurId: string, entrepriseId: string },
): Promise<AccesConsultant | null> {
  const aujourdHui = new Date()
  const row = await trx
    .selectFrom('acces_consultant')
    .select(['entreprise_id', 'ecriture', 'fin_le'])
    .where('utilisateur_id', '=', params.utilisateurId)
    .where('entreprise_id', '=', params.entrepriseId)
    .where((eb) => eb.or([eb('fin_le', 'is', null), eb('fin_le', '>=', aujourdHui)]))
    // Entreprise désactivée (cf. migration 0010) : l'accès n'est plus valide,
    // même si sa date de fin n'est pas dépassée.
    .where(sql<boolean>`entreprise_est_active(entreprise_id)`, '=', true)
    .executeTakeFirst()

  return row
    ? { entrepriseId: row.entreprise_id, ecriture: row.ecriture, finLe: row.fin_le }
    : null
}

/** Lève une erreur si le consultant n'a pas d'accès valide (et, si demandé, en écriture). */
export async function exigerAccesConsultant(
  trx: Transaction<DB>,
  params: { utilisateurId: string, entrepriseId: string, ecriture?: boolean },
): Promise<AccesConsultant> {
  const acces = await accesConsultantValide(trx, params)
  if (!acces) {
    throw new Error("Accès refusé : aucun accès consultant valide à cette entreprise.")
  }
  if (params.ecriture && !acces.ecriture) {
    throw new Error('Accès refusé : accès consultant en lecture seule.')
  }
  return acces
}

/** Toutes les entreprises auxquelles le consultant a un accès valide (sélecteur post-connexion). */
export async function listerAccesConsultantValides(
  trx: Transaction<DB>,
  utilisateurId: string,
): Promise<AccesConsultant[]> {
  const aujourdHui = new Date()
  const rows = await trx
    .selectFrom('acces_consultant')
    .select(['entreprise_id', 'ecriture', 'fin_le'])
    .where('utilisateur_id', '=', utilisateurId)
    .where((eb) => eb.or([eb('fin_le', 'is', null), eb('fin_le', '>=', aujourdHui)]))
    .where(sql<boolean>`entreprise_est_active(entreprise_id)`, '=', true)
    .execute()
  return rows.map((r) => ({ entrepriseId: r.entreprise_id, ecriture: r.ecriture, finLe: r.fin_le }))
}
