import { sql } from 'kysely'
import { avecPlateformeAdmin } from '@/auth/contexte'
import { jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { ErreurMetier } from '@/inspections/service'
import { accorderAcces, creerClient, creerConsultant, reinitialiserMotDePasseConsultant, supprimerConsultant, definirModule, lireAdministration, revoquerAcces } from './service'

/**
 * Administration : administrateur uniquement (avecPlateformeAdmin revérifie le
 * rôle et journalise chaque opération avant tout effet).
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

export const traiterLectureAdministration = (request: Request) =>
  repondre(async () => json(200, await avecPlateformeAdmin(jetonDepuisRequete(request), 'lister_entreprises', (trx) => lireAdministration(trx))))

export const traiterCreationClient = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await avecPlateformeAdmin(jetonDepuisRequete(request), 'creer_entreprise', (trx) => creerClient(trx, corps),
      { nom: typeof corps.nom === 'string' ? corps.nom : null }))
  })

/** Corps : { action: 'module', module, actif } | { action: 'acces', consultantId, ecriture, finLe } | { action: 'revoquer', consultantId }. */
export const traiterModificationEntreprise = (request: Request, entrepriseId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    const jeton = jetonDepuisRequete(request)
    const details = { entrepriseId, action: corps.action }
    switch (corps.action) {
      case 'module':
        await avecPlateformeAdmin(jeton, corps.actif === false ? 'desactiver_module' : 'activer_module',
          (trx) => definirModule(trx, entrepriseId, corps.module, corps.actif), { ...details, module: corps.module })
        break
      case 'acces':
        await avecPlateformeAdmin(jeton, 'accorder_acces_consultant', (trx) => accorderAcces(trx, entrepriseId, corps), details)
        break
      case 'revoquer':
        await avecPlateformeAdmin(jeton, 'revoquer_acces_consultant', (trx) => revoquerAcces(trx, entrepriseId, corps.consultantId), details)
        break
      default:
        throw new ErreurMetier(400, 'Action inconnue.')
    }
    return json(200, { ok: true })
  })

/** Création d'un compte consultant (administrateur) : le mot de passe provisoire n'est renvoyé que dans cette réponse. */
export const traiterCreationConsultant = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    return json(201, await avecPlateformeAdmin(jetonDepuisRequete(request), 'creer_compte_consultant', (trx, ctx) => creerConsultant(trx, ctx, corps)))
  })

/** Suppression définitive d'un consultant (administrateur) : corps { confirmation: email du consultant }. */
export const traiterSuppressionConsultant = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await avecPlateformeAdmin(jetonDepuisRequete(request), 'supprimer_compte_consultant', (trx, ctx) => supprimerConsultant(trx, ctx, id, corps), { consultantId: id })
    return json(200, { ok: true })
  })

/** Réinitialisation du mot de passe d'un consultant (administrateur) : corps { action: 'mot_de_passe' } ; le nouveau mot de passe n'est renvoyé que dans cette réponse. */
export const traiterModificationConsultant = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    if (corps.action !== 'mot_de_passe') throw new ErreurMetier(400, 'Action inconnue.')
    return json(200, await avecPlateformeAdmin(jetonDepuisRequete(request), 'reinitialiser_mdp_consultant', (trx, ctx) => reinitialiserMotDePasseConsultant(trx, ctx, id), { consultantId: id }))
  })

/** Réinitialise la 2FA d'un compte (téléphone perdu) : administrateur seulement, tracé ; le compte devra la réactiver à sa prochaine connexion. */
export const traiterReinitialisation2fa = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await avecPlateformeAdmin(jetonDepuisRequete(request), 'reinitialiser_2fa', async (trx) => {
      try {
        await sql`select reinitialiser_2fa_utilisateur(${id}::uuid)`.execute(trx)
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'IF404') throw new ErreurMetier(404, 'Compte introuvable.')
        if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
        throw e
      }
    }, { compteId: id })
    return json(200, { ok: true })
  })
