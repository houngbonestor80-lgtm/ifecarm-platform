import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces, avecTenant, type ContexteSession } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { changerActifCompte, creerCompte, listerComptes, reinitialiserMotDePasse } from './service'

/**
 * Comptes d'accès du client ou du prospect actif : réservé au consultant
 * IFECARM / admin_plateforme ayant un accès en ÉCRITURE à cette entreprise.
 * Les mots de passe provisoires ne sont renvoyés qu'en réponse à la création
 * ou à la réinitialisation (jamais relisibles ; json() pose déjà no-store).
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const consultantEcriture = <T>(request: Request, cb: (trx: Transaction<DB>, ctx: ContexteSession & { entrepriseId: string }) => Promise<T>) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Gestion des accès réservée à IFECARM GROUP.')
    return cb(trx, ctx)
  })

export const traiterListeComptes = (request: Request) =>
  repondre(async () => json(200, { comptes: await consultantEcriture(request, (trx) => listerComptes(trx)) }))

export const traiterCreationCompte = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await consultantEcriture(request, (trx, ctx) => creerCompte(trx, ctx, corps)))
  })

export const traiterModificationCompte = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    if (corps.action === 'mot_de_passe') {
      return json(200, await consultantEcriture(request, (trx, ctx) => reinitialiserMotDePasse(trx, ctx, id)))
    }
    await consultantEcriture(request, (trx, ctx) => changerActifCompte(trx, ctx, id, corps.actif))
    return json(200, { ok: true })
  })
