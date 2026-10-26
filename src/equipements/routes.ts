import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces, avecTenant, lireContexte, type ContexteSession } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ErreurMetier } from '@/inspections/service'
import { ajouterPhotoEquipement } from '@/inspections/photos'
import { genererRapportEquipements } from './rapport'
import { changerActif, enregistrerEquipement, enregistrerVerification, listerEquipements, supprimerEquipement } from './service'

/**
 * Registre des équipements et EPI. Lecture : tout utilisateur du tenant.
 * Écriture : consultant IFECARM avec accès en écriture uniquement — client et
 * prospect consultent seulement.
 */

const MODULE = 'inspections' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

const ecriture = <T>(request: Request, cb: (trx: Transaction<DB>, ctx: ContexteSession & { entrepriseId: string }) => Promise<T>) =>
  avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Registre tenu par votre consultant IFECARM GROUP : consultation seule.')
    return cb(trx, ctx)
  })

export const traiterListeEquipements = (request: Request) =>
  repondre(async () => {
    const jeton = jetonDepuisRequete(request)
    const r = await avecTenant(jeton, { module: MODULE }, (trx) => listerEquipements(trx))
    const ctx = await lireContexte(jeton)
    const consultant = Boolean(ctx?.estConsultant || ctx?.estAdminPlateforme)
    // Consultant en lecture seule : pas de gestion non plus.
    const peutGerer = consultant && await avecTenant(jeton, { ecriture: true, module: MODULE }, async () => true).catch(() => false)
    return json(200, { ...r, peutGerer })
  })

export const traiterCreationEquipement = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecriture(request, (trx, ctx) => enregistrerEquipement(trx, ctx, null, corps)))
  })

export const traiterModificationEquipement = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecriture(request, async (trx, ctx) => {
      if (corps.action === 'verification') return enregistrerVerification(trx, id, corps)
      if (corps.action === 'actif') return changerActif(trx, id, corps.actif)
      return enregistrerEquipement(trx, ctx, id, corps)
    })
    return json(200, { ok: true })
  })

export const traiterSuppressionEquipement = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecriture(request, (trx, ctx) => supprimerEquipement(trx, ctx, id))
    return json(200, { ok: true })
  })

/** Rapport PDF du registre : tout utilisateur du tenant ayant le module (le client télécharge son livrable). */
export const traiterRapportEquipements = (request: Request) =>
  repondre(async () => {
    const { octets, nomFichier } = await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx, ctx) => genererRapportEquipements(trx, ctx))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${nomFichier}"`, 'cache-control': 'private, no-store' },
    })
  })

/** Photo d'un équipement (multipart : photo) : consultant en écriture, comme le reste du registre. */
export const traiterAjoutPhotoEquipement = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const form = await request.formData().catch(() => null)
    const photo = form?.get('photo')
    if (!form || !(photo instanceof File)) throw new ErreurMetier(400, 'Photo manquante.')
    const entree = { octets: new Uint8Array(await photo.arrayBuffer()), nom: photo.name }
    return json(201, await ecriture(request, (trx, ctx) => ajouterPhotoEquipement(trx, ctx, id, entree)))
  })
