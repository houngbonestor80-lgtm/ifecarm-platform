import { ErreurMetier } from '@/inspections/service'
import { ErreurAcces } from './contexte'

/**
 * Briques HTTP communes aux routes d'authentification (Request/Response
 * standards : testables sans serveur Next).
 *
 * Cookie de session : httpOnly (illisible depuis le JavaScript de la page, donc
 * hors de portée d'un script injecté), SameSite=Lax, Secure en production. Le
 * jeton en clair n'existe que dans ce cookie ; la base ne garde que son hash.
 */

export const NOM_COOKIE_SESSION = 'ifecarm_session'

/** Appareil de confiance (2FA) : cookie distinct de la session, valable 30 jours, seul son hash est en base. */
export const NOM_COOKIE_APPAREIL = 'ifecarm_appareil'
export const DUREE_APPAREIL_JOURS = 30

export function cookieDepuisRequete(request: Request, nomCookie: string): string | null {
  const brut = request.headers.get('cookie')
  if (!brut) return null
  for (const morceau of brut.split(';')) {
    const [nom, ...reste] = morceau.trim().split('=')
    if (nom === nomCookie) return decodeURIComponent(reste.join('=')) || null
  }
  return null
}

export const appareilDepuisRequete = (request: Request) => cookieDepuisRequete(request, NOM_COOKIE_APPAREIL)

export function cookieAppareil(jeton: string, expireLe: Date): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${NOM_COOKIE_APPAREIL}=${encodeURIComponent(jeton)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expireLe.toUTCString()}${secure}`
}

export function cookieAppareilEffacement(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${NOM_COOKIE_APPAREIL}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`
}

export function jetonDepuisRequete(request: Request): string | null {
  const brut = request.headers.get('cookie')
  if (!brut) return null
  for (const morceau of brut.split(';')) {
    const [nom, ...reste] = morceau.trim().split('=')
    if (nom === NOM_COOKIE_SESSION) return decodeURIComponent(reste.join('=')) || null
  }
  return null
}

export function cookieSession(jeton: string, expireLe: Date): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${NOM_COOKIE_SESSION}=${encodeURIComponent(jeton)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expireLe.toUTCString()}${secure}`
}

export function cookieEffacement(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${NOM_COOKIE_SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`
}

/**
 * Protection CSRF des requêtes qui modifient l'état : l'en-tête Origin (posé
 * par le navigateur, non falsifiable depuis une page tierce) doit désigner
 * notre propre hôte. Complète SameSite=Lax du cookie.
 */
export function origineValide(request: Request): boolean {
  const origine = request.headers.get('origin')
  const hote = request.headers.get('host')
  if (!origine || !hote) return false
  try {
    return new URL(origine).host === hote
  } catch {
    return false
  }
}

/**
 * Adresse IP de l'appelant. x-forwarded-for n'est fiable que derrière un
 * proxy de confiance qui l'écrase : à revoir au déploiement (une valeur
 * forgée permettrait de contourner la limitation par IP, pas celle par email).
 */
export function adresseIp(request: Request): string {
  const transmis = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return transmis || '127.0.0.1'
}

export function json(statut: number, corps: unknown, entetes: Record<string, string | string[]> = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })
  for (const [nom, valeur] of Object.entries(entetes)) {
    for (const v of Array.isArray(valeur) ? valeur : [valeur]) headers.append(nom, v)
  }
  return new Response(JSON.stringify(corps), { status: statut, headers })
}

/** Traduit les erreurs d'accès en réponses HTTP ; toute autre erreur reste opaque (500), jamais détaillée. */
export async function repondre(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ErreurAcces || e instanceof ErreurMetier) return json(e.statut, { erreur: e.message })
    console.error('[auth] erreur interne', e)
    return json(500, { erreur: 'Erreur interne.' })
  }
}
