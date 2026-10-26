import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { withoutTenant } from '@/db/tenant'
import { ErreurMetier } from '@/inspections/service'
import { envoyerEmail, urlPublique, type Courriel } from '@/notifications/email'
import { hacherMotDePasse } from './password'

/**
 * Réinitialisation du mot de passe par e-mail (migration 0045).
 *   - La demande répond TOUJOURS pareil (compte inconnu, inactif, limite atteinte, e-mail en panne) : on n'apprend pas
 *     quels comptes existent. L'e-mail part en arrière-plan : le temps de réponse ne distingue pas non plus.
 *   - Lien à usage unique, valable 60 minutes ; seul son hash SHA-256 est en base. 3 demandes par compte et par heure,
 *     10 par adresse IP et par heure.
 *   - Réinitialiser révoque toutes les sessions et tous les appareils de confiance, mais ne touche PAS à la 2FA.
 */

export const VALIDITE_LIEN_MINUTES = 60
const hacherJeton = (j: string) => createHash('sha256').update(j).digest('hex')
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

export function courrielReinitialisation(nom: string, email: string, jeton: string): Courriel {
  const lien = `${urlPublique()}/reinitialiser?jeton=${encodeURIComponent(jeton)}`
  return {
    a: email,
    sujet: 'Réinitialisation de votre mot de passe — IFECARM GROUP',
    texte: [
      `Bonjour ${nom},`,
      '',
      'Vous avez demandé à réinitialiser votre mot de passe sur la plateforme QHSE IFECARM GROUP.',
      `Ce lien est valable ${VALIDITE_LIEN_MINUTES} minutes et ne sert qu'une seule fois :`,
      '',
      lien,
      '',
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.',
      'Si la double authentification est activée sur votre compte, elle le reste après la réinitialisation.',
      '',
      'IFECARM GROUP',
    ].join('\n'),
  }
}

/** `envoi` : promesse de l'envoi, pour les tests ; la route ne l'attend pas. */
export async function demanderReinitialisation(
  emailBrut: unknown,
  adresseIp: string,
  envoyer: (c: Courriel) => Promise<void> = envoyerEmail,
): Promise<{ envoi?: Promise<void> }> {
  const email = typeof emailBrut === 'string' ? emailBrut.trim().toLowerCase() : ''
  if (!EMAIL.test(email) || email.length > 200) return {}
  const permis = await withoutTenant(async (trx) => (await sql<{ ok: boolean }>`select limite_reinitialisation_ip(${adresseIp}::inet) as ok`.execute(trx)).rows[0]?.ok === true)
  if (!permis) return {}

  const jeton = randomBytes(32).toString('base64url')
  const { rows: [u] } = await withoutTenant((trx) =>
    sql<{ utilisateur_id: string, email: string, nom: string }>`select * from demander_reinitialisation(${email}::citext, ${hacherJeton(jeton)}, ${VALIDITE_LIEN_MINUTES})`.execute(trx))
  if (!u) return {}

  const envoi = envoyer(courrielReinitialisation(u.nom, u.email, jeton)).catch((e) => {
    // Jamais le contenu du message (il porte le lien) : seulement le fait et la cause.
    console.error('[auth] envoi du lien de réinitialisation impossible :', (e as Error).message)
  })
  return { envoi }
}

/** Valide le jeton et pose le nouveau mot de passe (même politique que le changement : 10 à 200 caractères). */
export async function reinitialiserMotDePasse(jetonBrut: unknown, nouveau: unknown): Promise<void> {
  if (typeof jetonBrut !== 'string' || jetonBrut.length < 20 || jetonBrut.length > 100) throw new ErreurMetier(400, 'Lien invalide ou expiré.')
  if (typeof nouveau !== 'string' || nouveau.length < 10) throw new ErreurMetier(400, 'Le mot de passe doit contenir au moins 10 caractères.')
  if (nouveau.length > 200) throw new ErreurMetier(400, 'Mot de passe trop long (200 caractères maximum).')
  const hash = await hacherMotDePasse(nouveau)
  try {
    await withoutTenant((trx) => sql`select reinitialiser_mot_de_passe(${hacherJeton(jetonBrut)}, ${hash})`.execute(trx))
  } catch (e) {
    if ((e as { code?: string }).code === 'IF404') throw new ErreurMetier(400, 'Lien invalide ou expiré.')
    throw e
  }
}
