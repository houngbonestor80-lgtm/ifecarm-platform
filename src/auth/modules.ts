import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

export type Module = 'formations' | 'incidents' | 'habilitations' | 'inspections' | 'tableau_bord'

/**
 * Utilitaire d'activation de module (revue de sécurité, "Gestion des
 * modules") : un module futur s'y raccroche en une ligne, ex. en tête d'une
 * route API :
 *
 *   await exigerModuleActif(trx, { entrepriseId, module: 'formations' })
 *
 * L'appelant traduit l'erreur levée en 403 ; côté interface, la même
 * fonction moduleEstActif() permet de masquer l'entrée de menu correspondante.
 */
export async function moduleEstActif(
  trx: Transaction<DB>,
  params: { entrepriseId: string, module: Module },
): Promise<boolean> {
  // `fin_le` (colonne DATE) : Kysely veut un Date pour un opérande de
  // comparaison (pas la chaîne ISO acceptée en écriture) — un Date complet
  // se compare correctement à une colonne DATE côté Postgres.
  const aujourdHui = new Date()

  const row = await trx
    .selectFrom('abonnement_module')
    .select('id')
    .where('entreprise_id', '=', params.entrepriseId)
    .where('module', '=', params.module)
    .where('actif', '=', true)
    .where((eb) => eb.or([eb('fin_le', 'is', null), eb('fin_le', '>=', aujourdHui)]))
    .executeTakeFirst()

  return row !== undefined
}

export async function exigerModuleActif(
  trx: Transaction<DB>,
  params: { entrepriseId: string, module: Module },
): Promise<void> {
  if (!(await moduleEstActif(trx, params))) {
    throw new Error(`Module non actif pour cette entreprise : ${params.module}`)
  }
}
