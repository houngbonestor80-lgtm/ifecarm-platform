import { after } from 'next/server'
import { ErreurAcces, choisirEntreprise, lireContexte } from '@/auth/contexte'
import { adresseIp, jetonDepuisRequete, json, origineValide, repondre } from '@/auth/http'
import { withAuthenticatedUser } from '@/db/tenant'
import type { Courriel } from '@/notifications/email'
import { ErreurLimite, convertirMiniAudit, listerMiniAudits, questionnairesPublics, soumettreMiniAudit, suivreMiniAudit } from './service'

/**
 * Mini-audit gratuit (migration 0052). Public : questionnaires et envoi, sans compte. Équipe IFECARM (consultant,
 * admin) : liste, suivi, conversion en prospect.
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

const corpsJson = async (request: Request): Promise<Record<string, unknown>> => {
  const c = await request.json().catch(() => null)
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
}

export const traiterQuestionnairesMiniAudit = () => repondre(async () => json(200, await questionnairesPublics()))

/** Corps : { questionnaire, reponses: { idQuestion: code }, contact: { nom, entreprise, email, pays, consentement, … } }. */
export const traiterEnvoiMiniAudit = (request: Request, envoyer?: (c: Courriel) => Promise<void>) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    try {
      const r = await soumettreMiniAudit(await corpsJson(request), adresseIp(request), envoyer)
      // Les tests attendent l'envoi ; en production il part après la réponse (after : sans lui, Vercel coupe la fonction).
      if (envoyer) await r.envoi
      else { const envoi = r.envoi; after(() => envoi) }
      return json(201, { code: r.code, score: r.score, niveau: r.niveau })
    } catch (e) {
      if (e instanceof ErreurLimite) return json(429, { erreur: e.message })
      throw e
    }
  })

const equipe = async <T>(request: Request, cb: Parameters<typeof withAuthenticatedUser<T>>[1]) => {
  const ctx = await lireContexte(jetonDepuisRequete(request))
  if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants et administrateurs IFECARM GROUP.')
  return withAuthenticatedUser(ctx.utilisateurId, cb)
}

export const traiterListeMiniAudits = (request: Request) =>
  repondre(async () => json(200, { demandes: await equipe(request, (trx) => listerMiniAudits(trx)) }))

/** Corps : { statut: 'nouveau' | 'contacte' | 'sans_suite' }. */
export const traiterSuiviMiniAudit = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = await corpsJson(request)
    await equipe(request, (trx) => suivreMiniAudit(trx, id, corps.statut))
    return json(200, { ok: true })
  })

/** Crée le prospect, puis bascule la session dessus (comme la création terrain d'un prospect). */
export const traiterConversionMiniAudit = (request: Request, id: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const entrepriseId = await equipe(request, (trx) => convertirMiniAudit(trx, id))
    await choisirEntreprise(jetonDepuisRequete(request), entrepriseId)
    return json(201, { id: entrepriseId, destination: '/vue-ensemble' })
  })
