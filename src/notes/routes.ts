import { ErreurAcces, avecTenant } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ajouterNote, listerNotes, supprimerNote } from './service'

/** Notes internes : équipe IFECARM seulement (consultant ou admin) ; l'écriture exige l'accès en écriture. */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const equipe = <T>(request: Request, ecriture: boolean, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

export const traiterListeNotes = (request: Request) =>
  repondre(async () => {
    const url = new URL(request.url)
    return json(200, { notes: await equipe(request, false, (trx, ctx) => listerNotes(trx, ctx, url.searchParams.get('type'), url.searchParams.get('id'))) })
  })

export const traiterAjoutNote = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await request.json().catch(() => ({})) as Record<string, unknown>
    return json(201, await equipe(request, true, (trx, ctx) => ajouterNote(trx, ctx, corps)))
  })

export const traiterSuppressionNote = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await equipe(request, true, (trx, ctx) => supprimerNote(trx, ctx, id))
    return json(200, { ok: true })
  })
