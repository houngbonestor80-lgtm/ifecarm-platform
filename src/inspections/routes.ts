import { sql } from 'kysely'
import { withAuthenticatedUser } from '@/db/tenant'
import { ErreurAcces, avecTenant, choisirEntreprise, lireContexte, type ContexteSession } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { creerProspect } from './prospect'
import { lireDemandes, lireServiceAutre, lireServices } from '@/formations/demandes'
import { creerModele } from '@/modeles/service'
import { ajouterPhoto, lirePhoto, supprimerPhoto } from './photos'
import { genererRapport } from './rapport'
import { tableauDeBord, vueEnsemble } from './tableau'
import { moduleEstActif } from '@/auth/modules'
import {
  ErreurMetier, ajouterPoint, modifierPoint, pointsLibres, supprimerPoint, changerStatutAction, contexteEntreprise, creerInspection, creerPlanAction, declarerNonConformite,
  donneesCreation, enregistrerResultat, listerInspections, modifierHoraire, modifierIntervenants, obtenirInspection,
  supprimerInspection, terminerInspection,
} from './service'

/**
 * Routes du module inspections (Request → Response, testables sans serveur).
 *
 * TOUTES passent par avecTenant (src/auth/contexte.ts) : session valide,
 * entreprise active, accès consultant revérifié à chaque requête
 * (exigerAccesConsultant), module 'inspections' actif. Voir
 * src/app/api/inspections/LISEZ-MOI.md.
 *
 * Qui peut quoi :
 *   - lecture : tout utilisateur du tenant (client ou consultant) ;
 *   - conduite de l'inspection (création, checklist, non-conformités, plans
 *     d'action, clôture) : consultant IFECARM / admin_plateforme avec un
 *     accès en ÉCRITURE ;
 *   - statut d'un plan d'action : aussi l'utilisateur client, qui réalise les
 *     actions chez lui.
 */

const MODULE = 'inspections' as const
const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const exigerConsultant = (ctx: ContexteSession) => {
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) {
    throw new ErreurAcces(403, "Réservé aux consultants IFECARM : l'inspection est conduite par le consultant.")
  }
}

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

/** Écriture « conduite d'inspection » : consultant + accès en écriture + origine vérifiée. */
const ecritureConsultant = <T>(
  request: Request,
  cb: Parameters<typeof avecTenant<T>>[2],
) => avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async (trx, ctx) => {
  exigerConsultant(ctx)
  return cb(trx, ctx)
})

export const traiterContexte = (request: Request) =>
  repondre(async () => {
    const r = await avecTenant(jetonDepuisRequete(request), { module: MODULE }, async (trx, ctx) => ({
      entreprise: await contexteEntreprise(trx, ctx.entrepriseId),
      consultant: ctx.estConsultant || ctx.estAdminPlateforme,
      tableauDeBord: await moduleEstActif(trx, { entrepriseId: ctx.entrepriseId, module: 'tableau_bord' }),
      formations: await moduleEstActif(trx, { entrepriseId: ctx.entrepriseId, module: 'formations' }),
      incidents: await moduleEstActif(trx, { entrepriseId: ctx.entrepriseId, module: 'incidents' }),
      habilitations: await moduleEstActif(trx, { entrepriseId: ctx.entrepriseId, module: 'habilitations' }),
      autodiagnostic: await moduleEstActif(trx, { entrepriseId: ctx.entrepriseId, module: 'autodiagnostic' }),
      moi: ctx.utilisateurId,
      entrepriseId: ctx.entrepriseId,
    }))
    // Droit d'écriture du consultant (sans lever d'erreur s'il est en lecture seule).
    let ecriture = false
    if (r.consultant) {
      ecriture = await avecTenant(jetonDepuisRequete(request), { ecriture: true, module: MODULE }, async () => true).catch(() => false)
    }
    return json(200, { ...r, peutConduire: r.consultant && ecriture })
  })

/** Tableau de bord de l'entreprise active : lecture pour tout utilisateur du tenant, module tableau_bord requis. */
export const traiterTableauDeBord = (request: Request) =>
  repondre(async () =>
    json(200, await avecTenant(jetonDepuisRequete(request), { module: 'tableau_bord' }, (trx, ctx) => tableauDeBord(trx, ctx.entrepriseId))))

/** Vue d'ensemble de tous les clients et prospects : commune au consultant et à l'administrateur, aucune entreprise à choisir. */
export const traiterVueEnsemble = (request: Request) =>
  repondre(async () => {
    const ctx = await lireContexte(jetonDepuisRequete(request))
    if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants et administrateurs IFECARM GROUP.')
    return json(200, {
      administrateur: ctx.estAdminPlateforme,
      entreprises: await withAuthenticatedUser(ctx.utilisateurId, (trx) => vueEnsemble(trx)),
    })
  })

export const traiterListe = (request: Request) =>
  repondre(async () => json(200, {
    inspections: await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx) => listerInspections(trx)),
  }))

export const traiterDonneesCreation = (request: Request) =>
  repondre(async () => json(200, await ecritureConsultant(request, (trx) => donneesCreation(trx))))

export const traiterCreation = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecritureConsultant(request, async (trx, ctx) => {
      // Checklist libre « à garder » : elle devient un modèle de l'entreprise (réutilisable, visible dans /modeles).
      if ((corps.modeleId === undefined || corps.modeleId === null || corps.modeleId === '') && corps.enregistrerModele === true) {
        const points = pointsLibres(corps.points)
        const modele = await creerModele(trx, ctx.entrepriseId, {
          intitule: corps.intitule, domaine: corps.domaine || 'Personnalisé', cibleType: corps.cibleType, items: points.map((libelle) => ({ libelle })),
        })
        return creerInspection(trx, ctx, { ...corps, modeleId: modele.id })
      }
      return creerInspection(trx, ctx, corps)
    }))
  })

/** Point de contrôle écrit par l'inspecteur, ajouté à une inspection ouverte. */
export const traiterAjoutPoint = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecritureConsultant(request, (trx, ctx) => ajouterPoint(trx, ctx, id, corps)))
  })

export const traiterSuppressionPoint = (request: Request, id: string, itemId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecritureConsultant(request, (trx) => supprimerPoint(trx, id, itemId))
    return json(200, { ok: true })
  })

export const traiterDetail = (request: Request, id: string) =>
  repondre(async () => json(200, {
    inspection: await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx) => obtenirInspection(trx, id)),
  }))

export const traiterResultat = (request: Request, id: string, itemId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    // Reformuler un point écrit par l'inspecteur (libellé) OU enregistrer son verdict / commentaire.
    await ecritureConsultant(request, (trx) => ('libelle' in corps ? modifierPoint(trx, id, itemId, corps) : enregistrerResultat(trx, id, itemId, corps)))
    return json(200, { ok: true })
  })

export const traiterNonConformite = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecritureConsultant(request, (trx, ctx) => declarerNonConformite(trx, ctx, id, corps)))
  })

export const traiterPlanAction = (request: Request, nonConformiteId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await ecritureConsultant(request, (trx, ctx) => creerPlanAction(trx, ctx, nonConformiteId, corps)))
  })

export const traiterTerminer = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecritureConsultant(request, (trx) => terminerInspection(trx, id))
    return json(200, { ok: true })
  })

/** Suppression (ou annulation, selon la règle mixte) : conduite d'inspection uniquement. */
export const traiterSuppression = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    return json(200, await ecritureConsultant(request, (trx, ctx) => supprimerInspection(trx, ctx, id)))
  })

/** Noms de l'inspecteur et du représentant du client : conduite d'inspection. */
export const traiterIntervenants = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecritureConsultant(request, (trx) => modifierIntervenants(trx, id, corps))
    return json(200, { ok: true })
  })

/** Photo (multipart : photo, cible = item|nc, cibleId) : conduite d'inspection. */
export const traiterAjoutPhoto = (request: Request, inspectionId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const form = await request.formData().catch(() => null)
    const photo = form?.get('photo')
    if (!form || !(photo instanceof File)) throw new ErreurMetier(400, 'Photo manquante.')
    const entree = { cible: form.get('cible'), cibleId: form.get('cibleId'), octets: new Uint8Array(await photo.arrayBuffer()), nom: photo.name }
    return json(201, await ecritureConsultant(request, (trx, ctx) => ajouterPhoto(trx, ctx, inspectionId, entree)))
  })

/** Affichage d'une photo : tout utilisateur du tenant (client compris), servie par la plateforme. */
export const traiterLecturePhoto = (request: Request, fichierId: string) =>
  repondre(async () => {
    const { octets, typeMime } = await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx) => lirePhoto(trx, fichierId))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: typeMime }), {
      status: 200,
      headers: { 'content-type': typeMime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
    })
  })

/** Rapport PDF : tout utilisateur du tenant (le client télécharge son livrable). */
export const traiterRapport = (request: Request, inspectionId: string) =>
  repondre(async () => {
    const { octets, nomFichier } = await avecTenant(jetonDepuisRequete(request), { module: MODULE }, (trx, ctx) =>
      genererRapport(trx, ctx, inspectionId))
    return new Response(new Blob([octets as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${nomFichier}"`,
        'cache-control': 'private, no-store',
      },
    })
  })

export const traiterSuppressionPhoto = (request: Request, fichierId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await ecritureConsultant(request, (trx) => supprimerPhoto(trx, fichierId))
    return json(200, { ok: true })
  })

/** Statut d'un plan d'action : consultant (écriture) uniquement — le client et le prospect consultent seulement. */
export const traiterStatutAction = (request: Request, actionId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecritureConsultant(request, (trx) => changerStatutAction(trx, actionId, corps))
    return json(200, { ok: true })
  })

/**
 * Création terrain d'un prospect par le consultant, puis bascule immédiate de
 * la session sur ce prospect (même contrôle d'accès que le sélecteur).
 */
export const traiterCreationProspect = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const jeton = jetonDepuisRequete(request)
    const ctx = await lireContexte(jeton)
    if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
    exigerConsultant(ctx)
    const corps = await corpsJson(request)
    if (typeof corps.nom !== 'string' || !corps.nom.trim()) return json(400, { erreur: 'Nom du prospect requis.' })
    const pays = typeof corps.pays === 'string' && corps.pays.trim() ? corps.pays.trim() : 'BJ'
    const secteur = typeof corps.secteur === 'string' && corps.secteur.trim() ? corps.secteur.trim() : undefined
    const services = lireServices(corps.services)
    if ('erreur' in services) return json(400, services)
    // Demandes de formation : seulement si le service « Formation » est coché.
    const demandes = lireDemandes(services.includes('formation') ? corps.formations : [])
    if ('erreur' in demandes) return json(400, demandes)
    const formations = JSON.stringify(demandes)
    const serviceAutre = lireServiceAutre(corps.serviceAutre)
    if (serviceAutre !== null && typeof serviceAutre === 'object') return json(400, serviceAutre)
    const paysValide = await withAuthenticatedUser(ctx.utilisateurId, (trx) =>
      trx.selectFrom('pays_intervention').select('code').where('code', '=', pays).where('actif', '=', true).executeTakeFirst())
    if (!paysValide) return json(400, { erreur: 'Pays d’intervention inconnu ou archivé.' })

    let id: string
    try {
      id = await withAuthenticatedUser(ctx.utilisateurId, (trx) => creerProspect(trx, { nom: corps.nom as string, pays, secteur }))
    } catch (e) {
      // Messages métier de creer_prospect() (plafond, bornes…) : affichables.
      const message = e instanceof Error ? e.message.replace(/^creer_prospect : /, '') : 'Création impossible.'
      return json(400, { erreur: message })
    }
    await withAuthenticatedUser(ctx.utilisateurId, (trx) => sql`select definir_souhaits_prospect(${id}, ${services}::text[], ${formations}::jsonb, ${serviceAutre})`.execute(trx))
    await choisirEntreprise(jeton, id)
    // Un prospect venu pour une inspection (ou sans précision) démarre directement son inspection ; sinon retour à la liste.
    const destination = services.length === 0 || services.includes('inspection') ? '/inspections/nouvelle' : '/vue-ensemble'
    return json(201, { id, destination })
  })

/** Date et horaires (début, fin) de l'inspection : décidés par le consultant. */
export const traiterHoraire = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await ecritureConsultant(request, (trx) => modifierHoraire(trx, id, corps))
    return json(200, { ok: true })
  })
