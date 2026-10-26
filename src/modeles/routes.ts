import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces, avecPlateformeAdmin, avecTenant, lireContexte } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { creerModele, listerModeles, modifierModele, obtenirModele, supprimerModele } from './service'

/**
 * Gestion des modèles d'inspection (« Admin + consultants ») :
 *   - lecture : tout utilisateur du tenant (catalogue + modèles de l'entreprise) ;
 *   - modèles de l'entreprise : consultant IFECARM avec accès en ÉCRITURE ;
 *   - catalogue IFECARM : admin_plateforme uniquement, via withPlatformAdmin
 *     (rôle revérifié, opération journalisée avant tout effet).
 */

const MODULE = 'inspections' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

/** Exécute `cb` dans le contexte qui a le droit d'écrire un modèle de cette portée. */
function ecrire<T>(request: Request, portee: unknown, cb: (trx: Transaction<DB>, entrepriseId: string | null) => Promise<T>) {
  const jeton = jetonDepuisRequete(request)
  if (portee === 'catalogue') {
    return avecPlateformeAdmin(jeton, 'gerer_catalogue_inspection', (trx) => cb(trx, null))
  }
  return avecTenant(jeton, { ecriture: true, module: MODULE }, (trx, ctx) => {
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Modèles gérés par votre consultant IFECARM GROUP.')
    return cb(trx, ctx.entrepriseId)
  })
}

const porteeDe = async (request: Request, id: string) =>
  (await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx) => obtenirModele(trx, id))).portee

export const traiterListeModeles = (request: Request) =>
  repondre(async () => {
    const jeton = jetonDepuisRequete(request)
    const modeles = await avecTenant(jeton, { module: MODULE }, (trx) => listerModeles(trx))
    const ctx = await lireContexte(jeton)
    const consultant = Boolean(ctx?.estConsultant || ctx?.estAdminPlateforme)
    const peutGererEntreprise = consultant && await avecTenant(jeton, { ecriture: true, module: MODULE }, async () => true).catch(() => false)
    const peutGererCatalogue = Boolean(ctx?.estAdminPlateforme)
    return json(200, {
      modeles: peutGererEntreprise || peutGererCatalogue ? modeles : modeles.filter((m) => m.actif),
      peutGererEntreprise,
      peutGererCatalogue,
    })
  })

export const traiterDetailModele = (request: Request, id: string) =>
  repondre(async () => json(200, { modele: await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx) => obtenirModele(trx, id)) }))

export const traiterCreationModele = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecrire(request, corps.portee, (trx, entrepriseId) => creerModele(trx, entrepriseId, corps)))
  })

export const traiterModificationModele = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecrire(request, await porteeDe(request, id), (trx) => modifierModele(trx, id, corps))
    return json(200, { ok: true })
  })

export const traiterSuppressionModele = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecrire(request, await porteeDe(request, id), (trx) => supprimerModele(trx, id))
    return json(200, { ok: true })
  })
