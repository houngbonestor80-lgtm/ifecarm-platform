import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

/**
 * Vue transverse IFECARM : comptages et ratios par entreprise, sans aucune
 * donnée personnelle. À appeler UNIQUEMENT sous withPlatformAdmin avec
 * l'opération 'consulter_indicateurs_plateforme' (la fonction SQL revérifie
 * le contexte ET le rôle admin_plateforme à l'intérieur).
 */
export interface IndicateursEntreprise {
  entreprise_id: string
  nom: string
  statut_relation: string
  actif: boolean
  recyclages_30j: number
  recyclages_7j: number
  recyclages_depasses: number
  declarations_ouvertes: number
  actions_en_retard: number
  actions_inspection_en_retard: number
  inspections_terminees_90j: number
  /** NUMERIC renvoyé en chaîne par pg ; null s'il n'y a aucun item évalué. */
  taux_conformite_90j: string | null
  nc_ouvertes_critique: number
  nc_ouvertes_total: number
}

export interface ResumePlateforme {
  clients_actifs: number
  clients_inactifs: number
  prospects: number
  prospects_acces_valide: number
  entreprises_desactivees: number
}

export async function indicateursPlateforme(trx: Transaction<DB>): Promise<IndicateursEntreprise[]> {
  const { rows } = await sql<IndicateursEntreprise>`select * from indicateurs_plateforme()`.execute(trx)
  return rows
}

export async function resumePlateforme(trx: Transaction<DB>): Promise<ResumePlateforme> {
  const { rows } = await sql<ResumePlateforme>`select * from resume_plateforme()`.execute(trx)
  return rows[0]!
}
