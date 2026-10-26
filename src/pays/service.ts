import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces } from '@/auth/contexte'
import { ErreurMetier } from '@/inspections/service'

/**
 * Pays d'intervention (migration 0021). Droits et règles sont contrôlés EN
 * BASE par les fonctions creer/modifier/supprimer_pays_intervention : ici,
 * traduction des codes d'erreur (IF403/IF404/IF409) en réponses HTTP.
 */

export async function listerPays(trx: Transaction<DB>) {
  const { rows } = await sql<{ code: string, nom: string, actif: boolean, entreprises: number }>`
    select p.code, p.nom, p.actif,
           (select count(*) from entreprise e where e.pays = p.code and not e.interne)::int as entreprises
    from pays_intervention p order by p.actif desc, p.nom
  `.execute(trx)
  return rows
}

async function appeler(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF403') throw new ErreurAcces(403, (e as Error).message)
    if (code === 'IF404') throw new ErreurMetier(404, (e as Error).message)
    if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
    throw e
  }
}

const chaine = (v: unknown, champ: string) => {
  if (typeof v !== 'string') throw new ErreurMetier(400, `${champ} requis.`)
  return v
}

export const creerPays = (trx: Transaction<DB>, corps: Record<string, unknown>) =>
  appeler(() => sql`select creer_pays_intervention(${chaine(corps.code, 'Code')}, ${chaine(corps.nom, 'Nom')})`.execute(trx))

export const modifierPays = (trx: Transaction<DB>, code: string, corps: Record<string, unknown>) => {
  if (typeof corps.actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
  return appeler(() => sql`select modifier_pays_intervention(${code}, ${chaine(corps.nom, 'Nom')}, ${corps.actif as boolean})`.execute(trx))
}

export const supprimerPays = (trx: Transaction<DB>, code: string) =>
  appeler(() => sql`select supprimer_pays_intervention(${code})`.execute(trx))
