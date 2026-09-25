import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

export type Role =
  | 'admin_entreprise'
  | 'responsable_qhse'
  | 'responsable_site'
  | 'declarant'
  | 'consultant_ifecarm'
  | 'admin_plateforme'

/**
 * Vérification de permission réutilisable (revue de sécurité, section 3) :
 * un rôle peut être limité à un site (site_id NULL dans role_utilisateur =
 * toute l'entreprise). À appeler DANS une transaction déjà ouverte par
 * withTenant — le rôle est une notion par entreprise, cf. RLS de
 * role_utilisateur dans migrations/0001_socle.sql.
 */
export async function possedeRole(
  trx: Transaction<DB>,
  params: { utilisateurId: string, role: Role, siteId?: string },
): Promise<boolean> {
  let query = trx
    .selectFrom('role_utilisateur')
    .select('id')
    .where('utilisateur_id', '=', params.utilisateurId)
    .where('role', '=', params.role)

  if (params.siteId) {
    const siteId = params.siteId
    query = query.where((eb) => eb.or([eb('site_id', 'is', null), eb('site_id', '=', siteId)]))
  }

  return (await query.executeTakeFirst()) !== undefined
}

/** Lève une erreur si le rôle est absent — pour les points d'entrée (routes API, Server Actions). */
export async function exigerRole(
  trx: Transaction<DB>,
  params: { utilisateurId: string, role: Role, siteId?: string },
): Promise<void> {
  if (!(await possedeRole(trx, params))) {
    throw new Error(`Permission refusée : rôle ${params.role} requis.`)
  }
}
