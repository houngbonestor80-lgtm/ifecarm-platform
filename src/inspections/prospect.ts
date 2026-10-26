import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

/**
 * Crée un prospect à la volée pour le consultant appelant (création terrain).
 *
 * À appeler sous withAuthenticatedUser(utilisateurId) : la fonction SQL lit
 * l'appelant dans app.utilisateur_id et revérifie elle-même qu'il s'agit d'un
 * consultant IFECARM actif. Elle crée l'entreprise (statut 'prospect'),
 * n'active que 'inspections', 'tableau_bord' et 'autodiagnostic', accorde au consultant appelant
 * un accès en écriture borné dans le temps, et journalise — rien d'autre.
 *
 * Retourne l'identifiant du prospect : le consultant peut ensuite entrer dans
 * cette entreprise avec withTenant (après exigerAccesConsultant, comme pour
 * n'importe quelle entreprise).
 */
export async function creerProspect(
  trx: Transaction<DB>,
  params: { nom: string, pays: string, secteur?: string, dureeAccesJours?: number },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select creer_prospect(${params.nom}, ${params.pays}, ${params.secteur ?? null}, ${params.dureeAccesJours ?? 90}) as id
  `.execute(trx)
  return rows[0]!.id
}
