import type { Transaction } from 'kysely'
import type { DB } from './types.generated'

export interface JournalEntry {
  utilisateurId: string | null
  entrepriseId: string | null
  /** creation, modification, suppression, connexion, export, ... */
  action: string
  objetType: string
  objetId?: string | null
  /** Ne jamais y mettre de donnée personnelle de salarié (cf. contrainte projet). */
  details?: Record<string, unknown> | null
  adresseIp?: string | null
}

/**
 * À appeler depuis l'intérieur d'une transaction déjà ouverte par
 * withTenant/withAuthenticatedUser/withPlatformAdmin — jamais en dehors,
 * puisque appDb n'est accessible que via ces wrappers.
 */
export async function ecrireJournal(trx: Transaction<DB>, entry: JournalEntry): Promise<void> {
  await trx
    .insertInto('journal_audit')
    .values({
      utilisateur_id: entry.utilisateurId,
      entreprise_id: entry.entrepriseId,
      action: entry.action,
      objet_type: entry.objetType,
      objet_id: entry.objetId ?? null,
      details: entry.details ? JSON.stringify(entry.details) : null,
      adresse_ip: entry.adresseIp ?? null,
    })
    .execute()
}
