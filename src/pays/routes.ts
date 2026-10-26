import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces, lireContexte } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { withAuthenticatedUser } from '@/db/tenant'
import { creerPays, listerPays, modifierPays, supprimerPays } from './service'

/**
 * Pays d'intervention. Lecture et ajout : consultant ou administrateur.
 * Renommer, archiver, supprimer : administrateur (vérifié en base).
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

async function interne<T>(request: Request, cb: (trx: Transaction<DB>, admin: boolean) => Promise<T>) {
  const ctx = await lireContexte(jetonDepuisRequete(request))
  if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
  return withAuthenticatedUser(ctx.utilisateurId, (trx) => cb(trx, ctx.estAdminPlateforme))
}

export const traiterListePays = (request: Request) =>
  repondre(async () => json(200, await interne(request, async (trx, admin) => ({ pays: await listerPays(trx), administrateur: admin }))))

export const traiterCreationPays = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await interne(request, (trx) => creerPays(trx, corps))
    return json(201, { ok: true })
  })

export const traiterModificationPays = (request: Request, code: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await interne(request, (trx) => modifierPays(trx, code, corps))
    return json(200, { ok: true })
  })

export const traiterSuppressionPays = (request: Request, code: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await interne(request, (trx) => supprimerPays(trx, code))
    return json(200, { ok: true })
  })
