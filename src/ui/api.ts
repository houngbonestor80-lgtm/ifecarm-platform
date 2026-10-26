'use client'

/**
 * Appels à l'API depuis le navigateur. Le cookie de session est envoyé
 * automatiquement (même origine) ; aucun identifiant d'entreprise ou
 * d'utilisateur n'est jamais transmis par le navigateur — c'est la session qui
 * les porte côté serveur.
 */
export class ErreurApi extends Error {
  constructor(public readonly statut: number, message: string) {
    super(message)
  }
}

export async function api<T = unknown>(chemin: string, options: { method?: string, corps?: unknown } = {}): Promise<T> {
  const r = await fetch(chemin, {
    method: options.method ?? 'GET',
    headers: options.corps === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.corps === undefined ? undefined : JSON.stringify(options.corps),
  })
  const donnees = await r.json().catch(() => ({}))
  if (r.status === 401) {
    window.location.assign('/connexion')
    throw new ErreurApi(401, 'Session expirée.')
  }
  if (r.status === 409 && typeof donnees.erreur === 'string' && donnees.erreur.startsWith('Aucune entreprise')) {
    window.location.assign('/entreprises')
    throw new ErreurApi(409, donnees.erreur)
  }
  if (!r.ok) throw new ErreurApi(r.status, donnees.erreur ?? 'Une erreur est survenue.')
  return donnees as T
}

export const messageErreur = (e: unknown) => (e instanceof Error ? e.message : 'Une erreur est survenue.')

/** Envoi multipart (photos) : même gestion d'erreurs que api(). */
export async function envoyerFormulaire<T = unknown>(chemin: string, form: FormData): Promise<T> {
  const r = await fetch(chemin, { method: 'POST', body: form })
  const donnees = await r.json().catch(() => ({}))
  if (r.status === 401) {
    window.location.assign('/connexion')
    throw new ErreurApi(401, 'Session expirée.')
  }
  if (!r.ok) throw new ErreurApi(r.status, donnees.erreur ?? 'Une erreur est survenue.')
  return donnees as T
}
