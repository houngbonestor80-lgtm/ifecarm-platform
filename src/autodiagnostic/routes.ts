import { ErreurAcces, avecPlateformeAdmin, avecTenant, type ContexteSession } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { genererRapportAutodiagnostic } from './rapport'
import {
  creerActionsDepuisEcarts, creerEvaluation, creerReferentiel, enregistrerReponses, listerCatalogue, listerEvaluations, listerReferentiels,
  modifierEvaluation, modifierReferentiel, obtenirEvaluation, obtenirReferentiel, resumeAutodiagnostic, supprimerEvaluation,
  supprimerReferentiel, terminerEvaluation,
} from './service'

/**
 * B1 autodiagnostic (module « autodiagnostic »). Écriture : équipe IFECARM (consultant avec accès en écriture, ou admin).
 * Lecture : équipe, et admin d'entreprise / responsable QHSE du client pour les évaluations TERMINÉES (la RLS de 0047 décide).
 * Catalogue des référentiels : administrateur.
 */

const MODULE = 'autodiagnostic' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const estEquipe = (ctx: ContexteSession) => ctx.estConsultant || ctx.estAdminPlateforme
const estResponsable = (ctx: ContexteSession) => ctx.roles.includes('admin_entreprise') || ctx.roles.includes('responsable_qhse')

const lecture = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { module: MODULE }, async (trx, ctx) => {
    if (!estEquipe(ctx) && !estResponsable(ctx)) throw new ErreurAcces(403, 'Réservé aux responsables du client et à l’équipe IFECARM.')
    return cb(trx, ctx)
  })

const equipe = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
    if (!estEquipe(ctx)) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

const identite = (ctx: ContexteSession) => ({ entrepriseId: ctx.entrepriseId!, utilisateurId: ctx.utilisateurId })

export const traiterListeAutodiagnostics = (request: Request) =>
  repondre(async () => {
    const jeton = jetonDepuisRequete(request)
    const r = await lecture(request, async (trx, ctx) => ({
      evaluations: await listerEvaluations(trx),
      referentiels: estEquipe(ctx) ? await listerReferentiels(trx) : [],
      sites: estEquipe(ctx) ? await trx.selectFrom('site').select(['id', 'nom']).where('actif', '=', true).orderBy('nom').limit(500).execute() : [],
      equipe: estEquipe(ctx),
    }))
    // Droit d'écriture (sans lever d'erreur pour un consultant en lecture seule).
    const peutConduire = r.equipe && await avecTenant(jeton, { ecriture: true, module: MODULE }, async () => true).catch(() => false)
    return json(200, { ...r, peutConduire })
  })

export const traiterResumeAutodiagnostic = (request: Request) =>
  repondre(async () => json(200, await lecture(request, (trx) => resumeAutodiagnostic(trx))))

export const traiterCreationAutodiagnostic = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerEvaluation(trx, identite(ctx), corps)))
  })

export const traiterDetailAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => json(200, { evaluation: await lecture(request, (trx) => obtenirEvaluation(trx, id)) }))

export const traiterModificationAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx, ctx) => modifierEvaluation(trx, id, identite(ctx), corps))
    return json(200, { ok: true })
  })

export const traiterReponsesAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(200, await equipe(request, (trx) => enregistrerReponses(trx, id, corps)))
  })

export const traiterTerminerAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    return json(200, { resultat: await equipe(request, (trx, ctx) => terminerEvaluation(trx, identite(ctx), id)) })
  })

export const traiterSuppressionAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await equipe(request, (trx, ctx) => supprimerEvaluation(trx, identite(ctx), id))
    return json(200, { ok: true })
  })

export const traiterActionsAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await equipe(request, (trx, ctx) => creerActionsDepuisEcarts(trx, identite(ctx), id, corps)))
  })

/** Rapport PDF d'une évaluation TERMINÉE : même visibilité que la lecture (le client télécharge son livrable). */
export const traiterRapportAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => {
    const { octets, nomFichier } = await lecture(request, (trx, ctx) => genererRapportAutodiagnostic(trx, { entrepriseId: ctx.entrepriseId! }, id))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${nomFichier}"`, 'cache-control': 'private, no-store' },
    })
  })

// --- Catalogue des référentiels : administrateur ---------------------------------------------------------

const admin = <T>(request: Request, cb: Parameters<typeof avecPlateformeAdmin<T>>[2], details?: Record<string, unknown>) =>
  avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_autodiagnostic', cb, details)

export const traiterCatalogueAutodiagnostic = (request: Request) =>
  repondre(async () => json(200, { referentiels: await admin(request, (trx) => listerCatalogue(trx)) }))

export const traiterReferentielAutodiagnostic = (request: Request, id: string) =>
  repondre(async () => json(200, { referentiel: await admin(request, (trx) => obtenirReferentiel(trx, id)) }))

export const traiterCreationReferentiel = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await admin(request, (trx) => creerReferentiel(trx, corps), { code: corps.code }))
  })

export const traiterModificationReferentiel = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await admin(request, (trx) => modifierReferentiel(trx, id, corps), { referentielId: id, champs: Object.keys(corps) })
    return json(200, { ok: true })
  })

export const traiterSuppressionReferentiel = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await admin(request, (trx) => supprimerReferentiel(trx, id), { referentielId: id })
    return json(200, { ok: true })
  })
