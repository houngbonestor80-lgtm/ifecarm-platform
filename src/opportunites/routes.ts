import { ErreurAcces, lireContexte } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { withAuthenticatedUser } from '@/db/tenant'
import { listerOpportunites, suivreOpportunite } from './service'

/** Opportunités de vente (migration 0053) : équipe IFECARM seulement (consultant, admin). */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const equipe = async <T>(request: Request, cb: Parameters<typeof withAuthenticatedUser<T>>[1]) => {
  const ctx = await lireContexte(jetonDepuisRequete(request))
  if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants et administrateurs IFECARM GROUP.')
  return { administrateur: ctx.estAdminPlateforme, resultat: await withAuthenticatedUser(ctx.utilisateurId, cb) }
}

/** ?horizon=90 (jours, 7 à 365). */
export const traiterListeOpportunites = (request: Request) =>
  repondre(async () => {
    const horizon = new URL(request.url).searchParams.get('horizon') ?? 90
    const r = await equipe(request, (trx) => listerOpportunites(trx, horizon))
    return json(200, { administrateur: r.administrateur, opportunites: r.resultat })
  })

export const traiterSuiviOpportunite = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await request.json().catch(() => null)
    await equipe(request, (trx) => suivreOpportunite(trx, corps && typeof corps === 'object' ? corps as Record<string, unknown> : {}))
    return json(200, { ok: true })
  })
