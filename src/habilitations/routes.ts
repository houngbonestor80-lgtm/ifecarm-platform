import { ErreurAcces, avecPlateformeAdmin, avecTenant, type ContexteSession } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ErreurMetier } from '@/inspections/service'
import {
  attestationsDuSalarie, creerHabilitation, creerSalarie, creerType, ficheSalarie, joindreJustificatif, lireJustificatif, listerTypes, matrice,
  modifierHabilitation, modifierType, renouveler, resumeHabilitations, retirerJustificatif, supprimerHabilitation,
} from './service'

/**
 * B4 habilitations (module « habilitations »). Lecture : équipe IFECARM, admin d'entreprise, responsable QHSE,
 * responsable de site (salariés de son site) — la RLS (0043) décide de ce que chacun voit ; les autres utilisateurs
 * du client reçoivent 403. Écriture : consultant ou admin avec accès en écriture. Catalogue : administrateur.
 */

const MODULE = 'habilitations' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const estEquipe = (ctx: ContexteSession) => ctx.estConsultant || ctx.estAdminPlateforme
const estResponsable = (ctx: ContexteSession) => ctx.roles.includes('admin_entreprise') || ctx.roles.includes('responsable_qhse')

const lecture = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { module: MODULE }, async (trx, ctx) => {
    if (!estEquipe(ctx) && !estResponsable(ctx) && !ctx.roles.includes('responsable_site')) throw new ErreurAcces(403, 'Réservé aux responsables et à l’équipe IFECARM.')
    return cb(trx, ctx)
  })

const equipe = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
    if (!estEquipe(ctx)) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

export const traiterContexteHabilitations = (request: Request) =>
  repondre(async () => json(200, await lecture(request, async (trx, ctx) => {
    const sites = await trx.selectFrom('site').select(['id', 'nom']).orderBy('nom').limit(500).execute()
    return { equipe: estEquipe(ctx), responsable: estResponsable(ctx), types: await listerTypes(trx), sites }
  })))

/** Responsable de site seul (ni équipe, ni responsable d'entreprise) : limité aux salariés de son site. */
const restreint = (ctx: ContexteSession) => !estEquipe(ctx) && !estResponsable(ctx)

export const traiterMatrice = (request: Request) =>
  repondre(async () => json(200, await lecture(request, (trx, ctx) => matrice(trx, restreint(ctx)))))

export const traiterFicheSalarie = (request: Request, id: string) =>
  repondre(async () => json(200, await lecture(request, (trx, ctx) => ficheSalarie(trx, id, restreint(ctx)))))

export const traiterAttestationsSalarie = (request: Request, id: string) =>
  repondre(async () => json(200, { attestations: await equipe(request, (trx) => attestationsDuSalarie(trx, id)) }))

export const traiterCreationSalarie = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerSalarie(trx, ctx, corps)))
  })

export const traiterCreationHabilitation = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerHabilitation(trx, ctx, corps)))
  })

export const traiterModificationHabilitation = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => modifierHabilitation(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterRenouvellement = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => renouveler(trx, ctx, id, corps)))
  })

export const traiterSuppressionHabilitation = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await equipe(request, (trx, ctx) => supprimerHabilitation(trx, ctx, id))
    return json(200, { ok: true })
  })

/** Justificatif (multipart : fichier) : un seul par titre, il remplace le précédent. */
export const traiterAjoutJustificatif = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const form = await request.formData().catch(() => null)
    const fichier = form?.get('fichier')
    if (!form || !(fichier instanceof File)) throw new ErreurMetier(400, 'Fichier manquant.')
    const entree = { octets: new Uint8Array(await fichier.arrayBuffer()), nom: fichier.name }
    return json(201, await equipe(request, (trx, ctx) => joindreJustificatif(trx, ctx, id, entree)))
  })

export const traiterLectureJustificatif = (request: Request, fichierId: string) =>
  repondre(async () => {
    const { octets, typeMime, nom } = await lecture(request, (trx) => lireJustificatif(trx, fichierId))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: typeMime }), {
      status: 200,
      headers: {
        'content-type': typeMime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(nom)}`,
      },
    })
  })

export const traiterSuppressionJustificatif = (request: Request, fichierId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await equipe(request, (trx, ctx) => retirerJustificatif(trx, ctx, fichierId))
    return json(200, { ok: true })
  })

/** Types propres à l'entreprise active (équipe IFECARM) ; ceux du catalogue se gèrent côté administrateur. */
export const traiterCreationType = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerType(trx, ctx.entrepriseId, corps)))
  })

export const traiterModificationType = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx) => modifierType(trx, id, corps, false))
    return json(200, { ok: true })
  })

/** Résumé du tableau de bord : ceux qui lisent toute l'entreprise (le responsable de site n'en verrait qu'une partie). */
export const traiterResumeHabilitations = (request: Request) =>
  repondre(async () => json(200, await lecture(request, async (trx, ctx) => {
    if (!estEquipe(ctx) && !estResponsable(ctx)) throw new ErreurAcces(403, 'Réservé aux responsables et à l’équipe IFECARM.')
    return resumeHabilitations(trx)
  })))

// --- Catalogue IFECARM : administrateur ---------------------------------------------------------------

export const traiterCatalogueHabilitations = (request: Request) =>
  repondre(async () => json(200, { types: await avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_habilitation', async (trx) =>
    (await listerTypes(trx)).filter((t) => t.entreprise_id === null)) }))

export const traiterCreationTypeCatalogue = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_habilitation', (trx) => creerType(trx, null, corps), { champs: Object.keys(corps) }))
  })

export const traiterModificationTypeCatalogue = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_habilitation', (trx) => modifierType(trx, id, corps, true), { typeId: id, champs: Object.keys(corps) })
    return json(200, { ok: true })
  })
