import { ErreurAcces, avecPlateformeAdmin, avecTenant } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { annulerAttestation, emettreAttestations, genererAttestationPdf, listerAttestationsSession } from './attestation'
import {
  ajouterParticipant, creerSession, enregistrerEmargement, listerCatalogue, listerCatalogueAdmin, listerDemandes, listerSalaries, listerSessions,
  modifierFormationCatalogue, modifierParticipant, modifierSession, obtenirSession, retirerParticipant,
} from './service'

/**
 * B2 formations. Lecture : tout utilisateur du tenant, module « formations »
 * actif (jamais proposé aux prospects). Écriture : consultant ou admin avec
 * accès en écriture ; la RLS de 0029 refuse de toute façon un client.
 * Catalogue (validité des certifications) : administrateur seulement.
 */

const MODULE = 'formations' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const lecture = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { module: MODULE }, cb)

const ecriture = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

const interne = <T>(request: Request, cb: Parameters<typeof avecTenant<T>>[2]) =>
  lecture(request, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à IFECARM GROUP.')
    return cb(trx, ctx)
  })

export const traiterCatalogue = (request: Request) =>
  repondre(async () => json(200, { formations: await lecture(request, (trx) => listerCatalogue(trx)) }))

export const traiterListeSessions = (request: Request) =>
  repondre(async () => json(200, { sessions: await lecture(request, (trx) => listerSessions(trx)) }))

export const traiterDetailSession = (request: Request, id: string) =>
  repondre(async () => json(200, { session: await lecture(request, (trx) => obtenirSession(trx, id)) }))

export const traiterCreationSession = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecriture(request, (trx, ctx) => creerSession(trx, ctx, corps)))
  })

export const traiterModificationSession = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecriture(request, (trx, ctx) => modifierSession(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterAjoutParticipant = (request: Request, sessionId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecriture(request, (trx, ctx) => ajouterParticipant(trx, ctx, sessionId, corps)))
  })

export const traiterModificationParticipant = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecriture(request, (trx, ctx) => modifierParticipant(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterRetraitParticipant = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecriture(request, (trx, ctx) => retirerParticipant(trx, ctx, id))
    return json(200, { ok: true })
  })

export const traiterEmargement = (request: Request, participantId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecriture(request, (trx, ctx) => enregistrerEmargement(trx, ctx, participantId, corps))
    return json(200, { ok: true })
  })

export const traiterSalaries = (request: Request) =>
  repondre(async () => json(200, { salaries: await interne(request, (trx) => listerSalaries(trx)) }))

export const traiterDemandes = (request: Request) =>
  repondre(async () => json(200, { demandes: await interne(request, (trx) => listerDemandes(trx)) }))

// --- Catalogue : administrateur ---------------------------------------------

export const traiterCatalogueAdmin = (request: Request) =>
  repondre(async () => json(200, { formations: await avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_formation', (trx) => listerCatalogueAdmin(trx)) }))

export const traiterModificationCatalogue = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await avecPlateformeAdmin(jetonDepuisRequete(request), 'gerer_catalogue_formation', (trx) => modifierFormationCatalogue(trx, id, corps), { formationId: id, champs: Object.keys(corps) })
    return json(200, { ok: true })
  })

// --- Attestations -------------------------------------------------------------

export const traiterListeAttestations = (request: Request, sessionId: string) =>
  repondre(async () => json(200, { attestations: await lecture(request, (trx) => listerAttestationsSession(trx, sessionId)) }))

export const traiterEmissionAttestations = (request: Request, sessionId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    return json(200, await ecriture(request, (trx, ctx) => emettreAttestations(trx, ctx, sessionId)))
  })

export const traiterAnnulationAttestation = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecriture(request, (trx, ctx) => annulerAttestation(trx, ctx, id, corps))
    return json(200, { ok: true })
  })

export const traiterPdfAttestation = (request: Request, id: string) =>
  repondre(async () => {
    const origine = new URL(request.url).origin
    const { octets, nomFichier } = await lecture(request, (trx) => genererAttestationPdf(trx, id, origine))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${nomFichier}"`, 'cache-control': 'private, no-store' },
    })
  })
