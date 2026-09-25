import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

/**
 * Limitation des tentatives de connexion, par compte ET par IP dans la même
 * requête (le pire signal s'applique) : limiter uniquement par e-mail
 * laisserait un attaquant distribuer ses tentatives sur plusieurs IP ;
 * limiter uniquement par IP bloquerait les vrais utilisateurs d'un même NAT
 * partagé (bureau, mobile).
 *
 * Temporisation croissante, pas un blocage plat : au-delà du seuil, chaque
 * échec double le délai avant la tentative suivante, jusqu'à un plafond.
 */
const FENETRE_MINUTES = 15
const SEUIL_AVANT_TEMPORISATION = 5
const DELAI_BASE_SECONDES = 2
const DELAI_MAX_SECONDES = 15 * 60

export interface LimiteConnexionResult {
  autorise: boolean
  /** Secondes à attendre avant de retenter, si autorise === false. */
  attendreSecondes: number
}

export async function verifierLimiteConnexion(
  trx: Transaction<DB>,
  params: { email: string, adresseIp: string },
): Promise<LimiteConnexionResult> {
  const fenetre = new Date(Date.now() - FENETRE_MINUTES * 60_000)

  const tentatives = await trx
    .selectFrom('tentative_connexion')
    .select(['cree_le', 'reussie'])
    .where((eb) => eb.or([eb('email', '=', params.email), eb('adresse_ip', '=', params.adresseIp)]))
    .where('cree_le', '>=', fenetre)
    .orderBy('cree_le', 'desc')
    .execute()

  // Échecs consécutifs les plus récents (s'arrête à la dernière réussite, ou
  // au début de la fenêtre) : une connexion réussie remet le compteur à zéro.
  let echecsConsecutifs = 0
  for (const t of tentatives) {
    if (t.reussie) break
    echecsConsecutifs++
  }

  if (echecsConsecutifs < SEUIL_AVANT_TEMPORISATION) {
    return { autorise: true, attendreSecondes: 0 }
  }

  const delaiRequis = Math.min(
    DELAI_MAX_SECONDES,
    DELAI_BASE_SECONDES * 2 ** (echecsConsecutifs - SEUIL_AVANT_TEMPORISATION),
  )
  const derniereTentative = tentatives[0]
  const ecouleSecondes = derniereTentative
    ? (Date.now() - derniereTentative.cree_le.getTime()) / 1000
    : Number.POSITIVE_INFINITY

  if (ecouleSecondes >= delaiRequis) {
    return { autorise: true, attendreSecondes: 0 }
  }
  return { autorise: false, attendreSecondes: Math.ceil(delaiRequis - ecouleSecondes) }
}

export async function enregistrerTentative(
  trx: Transaction<DB>,
  params: { email: string, adresseIp: string, reussie: boolean },
): Promise<void> {
  await trx
    .insertInto('tentative_connexion')
    .values({ email: params.email, adresse_ip: params.adresseIp, reussie: params.reussie })
    .execute()
}
