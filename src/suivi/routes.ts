import { ErreurAcces, avecTenant } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ajouterNote, definirSouhaits, lireSouhaits, listerNotes, supprimerNote } from './service'

/**
 * Notes de suivi de l'entreprise active. Consultant ou administrateur
 * seulement (lecture : accès valide ; écriture : accès en écriture). Aucun
 * module requis : c'est un outil interne d'IFECARM GROUP.
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const interne = <T>(request: Request, ecriture: boolean, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

export const traiterListeNotes = (request: Request) =>
  repondre(async () => json(200, { notes: await interne(request, false, (trx) => listerNotes(trx)) }))

export const traiterAjoutNote = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await interne(request, true, (trx, ctx) => ajouterNote(trx, ctx, corps)))
  })

export const traiterSuppressionNote = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await interne(request, true, (trx, ctx) => supprimerNote(trx, ctx, id))
    return json(200, { ok: true })
  })

/** Souhaits de l'entreprise active : services et demandes de formation (consultant/admin ; écriture : accès en écriture). */
export const traiterLectureSouhaits = (request: Request) =>
  repondre(async () => json(200, await interne(request, false, (trx, ctx) => lireSouhaits(trx, ctx.entrepriseId))))

export const traiterModificationSouhaits = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await interne(request, true, (trx, ctx) => definirSouhaits(trx, ctx, corps))
    return json(200, { ok: true })
  })
