import { sql } from 'kysely'
import { withAuthenticatedUser, withTenant, withoutTenant } from '@/db/tenant'
import { ecrireJournal } from '@/db/journal'
import { enregistrerTentative, verifierLimiteConnexion } from './rateLimit'
import { hacherMotDePasse, verifierMotDePasse } from './password'
import { creerSession, definirEntrepriseSession, definirEtapeA2f } from './session'
import { a2fObligatoire, appareilEstDeConfiance } from './deuxfa'
import type { Role } from './permissions'

/**
 * Connexion par email + mot de passe.
 *
 * Ordre : limitation des tentatives → recherche de l'utilisateur → vérification
 * du mot de passe → création de session. Trois règles de sécurité :
 *
 * 1. Réponse UNIQUE pour « email inconnu », « mauvais mot de passe », « compte
 *    inactif » (raison 'identifiants') : on n'apprend pas quels comptes existent.
 *    Le temps de réponse est aussi égalisé : sans compte trouvé, on vérifie
 *    quand même un mot de passe contre un hash factice.
 * 2. Double authentification (0045). La session naît PARTIELLE (fail-closed) ; une fois
 *    les rôles connus, la connexion la libère (pas de 2FA requise, ou « appareil de
 *    confiance » valide), ou la laisse en attente du code (compte avec 2FA) ou de
 *    l'activation (rôle qui l'impose et 2FA pas encore activée). Tant qu'elle est
 *    partielle, validerSession la refuse partout sauf sur les routes 2FA.
 * 3. Aucun tenant n'est choisi ici. Un utilisateur d'une entreprise cliente a
 *    la sienne posée sur sa session ; un consultant ou un admin_plateforme
 *    démarre sans entreprise et DOIT en choisir une (avec contrôle d'accès).
 */

export type RaisonRefus = 'identifiants' | 'limite'

export interface ProfilConnexion {
  utilisateurId: string
  roles: Role[]
  /** Entreprise posée sur la session (null pour un consultant ou un admin_plateforme). */
  entrepriseId: string | null
  estConsultant: boolean
  estAdminPlateforme: boolean
}

export type ResultatConnexion =
  | { ok: true, jeton: string, expireLe: Date, profil: ProfilConnexion, a2f: 'code' | 'activation' | null }
  | { ok: false, raison: RaisonRefus, attendreSecondes?: number }

let hashFactice: Promise<string> | null = null
const obtenirHashFactice = () => (hashFactice ??= hacherMotDePasse('hash-factice-pour-egaliser-le-temps-de-reponse'))

export async function connecter(params: {
  email: string
  motDePasse: string
  adresseIp: string
  userAgent?: string
  /** Jeton du cookie « appareil de confiance », s'il y en a un. */
  appareilJeton?: string | null
}): Promise<ResultatConnexion> {
  const email = params.email.trim().toLowerCase()
  if (!email || !params.motDePasse) return { ok: false, raison: 'identifiants' }

  // Étape 1 (sans tenant) : limite, recherche, vérification, tentative, session.
  // Aucune exception ne doit remonter avant enregistrerTentative, sinon la
  // transaction annulerait l'enregistrement de l'échec.
  const etape = await withoutTenant(async (trx) => {
    const limite = await verifierLimiteConnexion(trx, { email, adresseIp: params.adresseIp })
    if (!limite.autorise) {
      return { ok: false as const, raison: 'limite' as const, attendreSecondes: limite.attendreSecondes }
    }

    const { rows } = await sql<{
      utilisateur_id: string
      entreprise_id: string
      mot_de_passe_hash: string | null
      totp_actif: boolean
    }>`select * from rechercher_utilisateur_connexion(${email})`.execute(trx)
    const trouve = rows[0]

    const hash = trouve?.mot_de_passe_hash ?? (await obtenirHashFactice())
    const motDePasseValide = await verifierMotDePasse(hash, params.motDePasse)
    const identifie = Boolean(trouve && trouve.mot_de_passe_hash && motDePasseValide)

    await enregistrerTentative(trx, { email, adresseIp: params.adresseIp, reussie: identifie })
    if (!identifie || !trouve) return { ok: false as const, raison: 'identifiants' as const }

    const session = await creerSession(trx, {
      utilisateurId: trouve.utilisateur_id,
      adresseIp: params.adresseIp,
      userAgent: params.userAgent,
      partielle: true,
    })
    return {
      ok: true as const,
      session,
      utilisateurId: trouve.utilisateur_id,
      entrepriseRattachement: trouve.entreprise_id,
      totpActif: trouve.totp_actif,
    }
  })

  if (!etape.ok) return etape

  // Étape 2 : rôles (lisibles par l'utilisateur lui-même), puis entreprise de session.
  const roles = await withAuthenticatedUser(etape.utilisateurId, async (trx) =>
    (await trx.selectFrom('role_utilisateur').select('role').where('utilisateur_id', '=', etape.utilisateurId).execute())
      .map((r) => r.role as Role),
  )
  // Deuxième facteur : code (2FA activée, sauf appareil de confiance), activation (rôle qui l'impose), ou rien.
  const appareilConnu = etape.totpActif && (await appareilEstDeConfiance(etape.utilisateurId, params.appareilJeton))
  const a2f: 'code' | 'activation' | null = etape.totpActif ? (appareilConnu ? null : 'code') : a2fObligatoire(roles) ? 'activation' : null
  await withoutTenant((trx) => definirEtapeA2f(trx, etape.session.sessionId, a2f))

  const estConsultant = roles.includes('consultant_ifecarm')
  const estAdminPlateforme = roles.includes('admin_plateforme')
  const privilegie = estConsultant || estAdminPlateforme

  const entrepriseId = privilegie ? null : etape.entrepriseRattachement
  if (entrepriseId) {
    await withoutTenant((trx) => definirEntrepriseSession(trx, { sessionId: etape.session.sessionId, entrepriseId }))
    await withTenant({ entrepriseId, utilisateurId: etape.utilisateurId }, (trx) =>
      ecrireJournal(trx, { utilisateurId: etape.utilisateurId, entrepriseId, action: 'connexion', objetType: 'session', objetId: etape.session.sessionId }),
    )
  }

  return {
    ok: true,
    jeton: etape.session.jeton,
    expireLe: etape.session.expireLe,
    profil: { utilisateurId: etape.utilisateurId, roles, entrepriseId, estConsultant, estAdminPlateforme },
    a2f,
  }
}
