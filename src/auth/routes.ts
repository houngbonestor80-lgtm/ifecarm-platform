import { after } from 'next/server'
import { connecter } from './connexion'
import { confirmerActivation, demarrerActivation, desactiverA2f, etatA2f, regenererCodesSecours, revoquerMesAppareils, verifierCodeConnexion } from './deuxfa'
import { demanderReinitialisation, reinitialiserMotDePasse } from './reinitialisation'
import type { Courriel } from '@/notifications/email'
import { avecTenant, changerMotDePasse, choisirEntreprise, convertirEnClient, deconnecter, lireContexte, listerEntreprisesAccessibles, supprimerEntreprise } from './contexte'
import { adresseIp, appareilDepuisRequete, cookieAppareil, cookieAppareilEffacement, cookieEffacement, cookieSession, jetonDepuisRequete, json, origineValide, repondre } from './http'

/**
 * Traitements des routes d'authentification, en fonctions (Request → Response)
 * pour être testés sans serveur. Les fichiers src/app/api/auth/** ne font que
 * les réexporter.
 *
 * Toute route qui MODIFIE l'état vérifie l'origine (CSRF) avant tout le reste.
 */

const REFUS_ORIGINE = () => json(403, { erreur: 'Origine de la requête non autorisée.' })

// Message volontairement identique quelle que soit la cause d'un échec de
// connexion (compte inconnu, mauvais mot de passe, compte inactif).
const MESSAGES_REFUS = {
  identifiants: 'Email ou mot de passe incorrect.',
  limite: 'Trop de tentatives. Réessayez plus tard.',
} as const

export const traiterConnexion = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { email?: unknown, motDePasse?: unknown } | null
    if (!corps || typeof corps.email !== 'string' || typeof corps.motDePasse !== 'string') {
      return json(400, { erreur: 'Email et mot de passe requis.' })
    }

    const resultat = await connecter({
      email: corps.email,
      motDePasse: corps.motDePasse,
      adresseIp: adresseIp(request),
      userAgent: request.headers.get('user-agent') ?? undefined,
      appareilJeton: appareilDepuisRequete(request),
    })

    if (!resultat.ok) {
      const statut = resultat.raison === 'limite' ? 429 : 401
      return json(
        statut,
        { erreur: MESSAGES_REFUS[resultat.raison], attendreSecondes: resultat.attendreSecondes },
        resultat.attendreSecondes ? { 'retry-after': String(resultat.attendreSecondes) } : {},
      )
    }

    const { profil } = resultat
    // Deuxième facteur à fournir : la session est partielle, la page 2FA prend le relais (saisie du code ou activation).
    const destination = resultat.a2f ? '/connexion/2fa' : profil.estConsultant || profil.estAdminPlateforme ? '/vue-ensemble' : '/'
    return json(
      200,
      { ok: true, destination, roles: profil.roles, a2f: resultat.a2f },
      { 'set-cookie': cookieSession(resultat.jeton, resultat.expireLe) },
    )
  })

export const traiterDeconnexion = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await deconnecter(jetonDepuisRequete(request))
    return json(200, { ok: true }, { 'set-cookie': cookieEffacement() })
  })

/** Qui suis-je ? Pour l'interface : jamais d'identifiant de tenant demandé au navigateur. */
export const traiterMoi = (request: Request) =>
  repondre(async () => {
    const ctx = await lireContexte(jetonDepuisRequete(request))
    if (!ctx) return json(401, { erreur: 'Non connecté.' })
    return json(200, {
      utilisateurId: ctx.utilisateurId,
      roles: ctx.roles,
      entrepriseId: ctx.entrepriseId,
      consultant: ctx.estConsultant,
      adminPlateforme: ctx.estAdminPlateforme,
    })
  })

export const traiterListeEntreprises = (request: Request) =>
  repondre(async () => {
    const entreprises = await listerEntreprisesAccessibles(jetonDepuisRequete(request))
    return json(200, {
      entreprises: entreprises.map((e) => ({
        id: e.entreprise_id,
        nom: e.nom,
        statutRelation: e.statut_relation,
        ecriture: e.ecriture,
        finLe: e.fin_le,
        supprimable: e.supprimable,
      })),
    })
  })

/** Conversion d'un prospect en client (administrateur). */
export const traiterConversionEntreprise = (request: Request, entrepriseId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await convertirEnClient(jetonDepuisRequete(request), entrepriseId)
    return json(200, { ok: true })
  })

/** Suppression définitive d'un prospect ou d'un client ; corps : { confirmation: nom de l'entreprise }. */
export const traiterSuppressionEntreprise = (request: Request, entrepriseId: string) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { confirmation?: unknown } | null
    if (!corps || typeof corps.confirmation !== 'string') return json(400, { erreur: 'Confirmation requise.' })
    await supprimerEntreprise(jetonDepuisRequete(request), entrepriseId, corps.confirmation)
    return json(200, { ok: true })
  })

/** Changement de son mot de passe ; corps : { actuel, nouveau }. */
export const traiterChangementMotDePasse = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { actuel?: unknown, nouveau?: unknown } | null
    await changerMotDePasse(jetonDepuisRequete(request), corps?.actuel, corps?.nouveau)
    return json(200, { ok: true })
  })

export const traiterChoixEntreprise = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { entrepriseId?: unknown } | null
    if (!corps || typeof corps.entrepriseId !== 'string') return json(400, { erreur: 'entrepriseId requis.' })
    await choisirEntreprise(jetonDepuisRequete(request), corps.entrepriseId)
    return json(200, { ok: true, destination: '/' })
  })

/** Sonde de contrôle d'accès de bout en bout : lit le tenant de la session, module inspections requis. */
export const traiterSondeTenant = (request: Request) =>
  repondre(async () => {
    const resultat = await avecTenant(jetonDepuisRequete(request), { module: 'inspections' }, async (trx, ctx) => {
      const { count } = await trx.selectFrom('inspection').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow()
      return { entrepriseId: ctx.entrepriseId, inspections: Number(count) }
    })
    return json(200, resultat)
  })

// ---------------------------------------------------------------------------
// Réinitialisation du mot de passe par e-mail
// ---------------------------------------------------------------------------

const REPONSE_DEMANDE = { ok: true, message: 'Si ce compte existe, un e-mail vient de lui être envoyé.' }

/** Demande de lien ; corps : { email }. Même réponse quoi qu'il arrive. `envoyer` : injecté par les tests. */
export const traiterDemandeReinitialisation = (request: Request, envoyer?: (c: Courriel) => Promise<void>) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { email?: unknown } | null
    const r = await demanderReinitialisation(corps?.email, adresseIp(request), envoyer)
    // Les tests attendent l'envoi ; en production il part après la réponse, via after() :
    // sans lui, Vercel arrête la fonction dès la réponse et l'e-mail peut ne jamais partir.
    if (envoyer) await r.envoi
    else if (r.envoi) { const envoi = r.envoi; after(() => envoi) }
    return json(200, REPONSE_DEMANDE)
  })

/** Nouveau mot de passe ; corps : { jeton, motDePasse }. */
export const traiterReinitialisation = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const corps = (await request.json().catch(() => null)) as { jeton?: unknown, motDePasse?: unknown } | null
    await reinitialiserMotDePasse(corps?.jeton, corps?.motDePasse)
    return json(200, { ok: true })
  })

// ---------------------------------------------------------------------------
// Double authentification
// ---------------------------------------------------------------------------

const corps2fa = async (request: Request) => ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>

/** État de la 2FA du compte (session complète OU en attente du deuxième facteur : la page 2FA en a besoin). */
export const traiterEtat2fa = (request: Request) =>
  repondre(async () => json(200, await etatA2f(jetonDepuisRequete(request))))

/** Saisie du code à la connexion ; corps : { code, secours?, memoriser? }. Un appareil de confiance reçoit son cookie. */
export const traiterVerification2fa = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const c = await corps2fa(request)
    const r = await verifierCodeConnexion(jetonDepuisRequete(request), { code: c.code, secours: c.secours === true, memoriser: c.memoriser === true }, {
      adresseIp: adresseIp(request), userAgent: request.headers.get('user-agent') ?? undefined,
    })
    const destination = r.roles.includes('consultant_ifecarm') || r.roles.includes('admin_plateforme') ? '/vue-ensemble' : '/'
    return json(200, { ok: true, destination, codesSecoursRestants: r.codesRestants }, r.appareil ? { 'set-cookie': cookieAppareil(r.appareil.jeton, r.appareil.expireLe) } : {})
  })

export const traiterDemarrageActivation2fa = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    return json(200, await demarrerActivation(jetonDepuisRequete(request)))
  })

/** Confirme l'activation avec un premier code ; renvoie les codes de secours UNE SEULE FOIS. */
export const traiterConfirmationActivation2fa = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const c = await corps2fa(request)
    const r = await confirmerActivation(jetonDepuisRequete(request), c.code, adresseIp(request))
    return json(200, { ok: true, ...r, destination: '/' })
  })

export const traiterDesactivation2fa = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const c = await corps2fa(request)
    await desactiverA2f(jetonDepuisRequete(request), { motDePasse: c.motDePasse, code: c.code }, adresseIp(request))
    return json(200, { ok: true })
  })

export const traiterCodesSecours2fa = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    const c = await corps2fa(request)
    return json(200, await regenererCodesSecours(jetonDepuisRequete(request), c.code, adresseIp(request)))
  })

export const traiterRevocationAppareils = (request: Request) =>
  repondre(async () => {
    if (!origineValide(request)) return REFUS_ORIGINE()
    await revoquerMesAppareils(jetonDepuisRequete(request))
    return json(200, { ok: true }, { 'set-cookie': cookieAppareilEffacement() })
  })
