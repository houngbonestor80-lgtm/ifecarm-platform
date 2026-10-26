import { ErreurAcces, avecTenant } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ErreurMetier } from '@/inspections/service'
import {
  ajouterCommentaire, ajouterPieceJointe, changerStatutActionDeclaration, creerAction, declarer, enregistrerAnalyse,
  lirePieceJointe, listerDeclarations, listerSalariesRegistre, listerSitesRegistre, modifierDeclaration, obtenirDeclaration,
  resumeRegistre, supprimerPieceJointe,
} from './service'

/**
 * B3 registre de sécurité (module « incidents »). Lecture et déclaration : tout utilisateur du tenant, la RLS
 * (0035-0038) décidant de ce que chacun voit. Qualification, analyse, actions, commentaires, suppression de
 * photo : consultant ou admin avec accès en écriture ; la RLS le refuse de toute façon à un client.
 */

const MODULE = 'incidents' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const lecture = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { module: MODULE }, cb)

/** Déclarer : tout utilisateur ; un consultant doit avoir son accès en écriture. */
const declaration = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, cb)

const equipe = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

/** Ce que l'écran doit proposer : formulaire (sites, salariés) et droits de l'utilisateur. */
export const traiterContexteRegistre = (request: Request) =>
  repondre(async () => json(200, await lecture(request, async (trx, ctx) => ({
    moi: ctx.utilisateurId,
    entrepriseId: ctx.entrepriseId,
    sites: await listerSitesRegistre(trx),
    salaries: await listerSalariesRegistre(trx),
    equipe: ctx.estConsultant || ctx.estAdminPlateforme,
    responsable: ctx.roles.includes('admin_entreprise') || ctx.roles.includes('responsable_qhse'),
    responsableSite: ctx.roles.includes('responsable_site'),
  }))))

export const traiterListe = (request: Request) =>
  repondre(async () => {
    const url = new URL(request.url)
    return json(200, { declarations: await lecture(request, (trx) => listerDeclarations(trx, { statut: url.searchParams.get('statut'), type: url.searchParams.get('type') })) })
  })

export const traiterDetail = (request: Request, id: string) =>
  repondre(async () => json(200, { declaration: await lecture(request, (trx) => obtenirDeclaration(trx, id)) }))

export const traiterDeclaration = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await declaration(request, (trx, ctx) => declarer(trx, ctx, corps)))
  })

export const traiterModification = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => modifierDeclaration(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterCommentaire = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => ajouterCommentaire(trx, ctx, id, corps))
    return json(201, { ok: true })
  })

export const traiterAnalyse = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => enregistrerAnalyse(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterCreationAction = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerAction(trx, ctx, id, corps)))
  })

export const traiterStatutAction = (request: Request, actionId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => changerStatutActionDeclaration(trx, ctx, actionId, corps))
    return json(200, { ok: true })
  })

/** Photo (multipart : photo, legende) : le déclarant joint à sa déclaration « à qualifier », l'équipe à tout moment. */
export const traiterAjoutPiece = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const form = await request.formData().catch(() => null)
    const photo = form?.get('photo')
    if (!form || !(photo instanceof File)) throw new ErreurMetier(400, 'Photo manquante.')
    const legende = form.get('legende')
    const entree = { octets: new Uint8Array(await photo.arrayBuffer()), nom: photo.name, legende: typeof legende === 'string' ? legende : null }
    return json(201, await declaration(request, (trx, ctx) => ajouterPieceJointe(trx, ctx, id, entree)))
  })

export const traiterLecturePiece = (request: Request, fichierId: string) =>
  repondre(async () => {
    const { octets, typeMime } = await lecture(request, (trx) => lirePieceJointe(trx, fichierId))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: typeMime }), {
      status: 200,
      headers: { 'content-type': typeMime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    })
  })

export const traiterSuppressionPiece = (request: Request, fichierId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await equipe(request, (trx, ctx) => supprimerPieceJointe(trx, ctx, fichierId))
    return json(200, { ok: true })
  })

/** Résumé du tableau de bord : responsables du client et équipe IFECARM (les autres ne voient qu'une partie des déclarations). */
export const traiterResumeRegistre = (request: Request) =>
  repondre(async () => json(200, await lecture(request, async (trx, ctx) => {
    const autorise = ctx.estConsultant || ctx.estAdminPlateforme || ctx.roles.includes('admin_entreprise') || ctx.roles.includes('responsable_qhse')
    if (!autorise) throw new ErreurAcces(403, 'Réservé aux responsables et à l’équipe IFECARM.')
    return resumeRegistre(trx)
  })))
