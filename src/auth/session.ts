import { createHash, randomBytes } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

const DUREE_SESSION_HEURES = 12

/** Le jeton en clair ne touche jamais la base : seul son empreinte SHA-256 est stockée. */
function hacherJeton(jeton: string): string {
  return createHash('sha256').update(jeton).digest('hex')
}

export interface SessionCreee {
  /** Jeton en clair : à placer dans le cookie httpOnly, jamais journalisé. */
  jeton: string
  sessionId: string
  expireLe: Date
}

/** À appeler sous withoutTenant, juste après authentification (mot de passe + 2FA) réussie. */
export async function creerSession(
  trx: Transaction<DB>,
  params: { utilisateurId: string, adresseIp?: string, userAgent?: string, partielle?: boolean },
): Promise<SessionCreee> {
  const jeton = randomBytes(32).toString('base64url')
  const expireLe = new Date(Date.now() + DUREE_SESSION_HEURES * 3_600_000)

  const row = await trx
    .insertInto('session')
    .values({
      utilisateur_id: params.utilisateurId,
      jeton_hash: hacherJeton(jeton),
      adresse_ip: params.adresseIp ?? null,
      user_agent: params.userAgent ?? null,
      expire_le: expireLe,
      // Fail-closed : une session créée après le seul mot de passe est partielle jusqu'à ce que la connexion la libère.
      a2f_requise: params.partielle ?? false,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return { jeton, sessionId: row.id, expireLe }
}

export interface SessionValide {
  sessionId: string
  utilisateurId: string
  entrepriseId: string | null
}

/** À appeler sous withoutTenant : c'est la requête qui établit qui est l'appelant. */
export async function validerSession(trx: Transaction<DB>, jeton: string): Promise<SessionValide | null> {
  const row = await trx
    .selectFrom('session')
    .select(['id', 'utilisateur_id', 'entreprise_id', 'expire_le', 'revoque_le', 'a2f_requise', 'a2f_validee_le'])
    .where('jeton_hash', '=', hacherJeton(jeton))
    .executeTakeFirst()

  if (!row || row.revoque_le !== null || row.expire_le.getTime() < Date.now()) {
    return null
  }
  // Session partielle (deuxième facteur non validé) : inutilisable partout, sauf par les routes 2FA (validerSessionPartielle).
  if (row.a2f_requise && row.a2f_validee_le === null) return null

  await trx
    .updateTable('session')
    .set({ derniere_activite: new Date() })
    .where('id', '=', row.id)
    .execute()

  return { sessionId: row.id, utilisateurId: row.utilisateur_id, entrepriseId: row.entreprise_id }
}

/** Choix ou changement d'entreprise active pour la session (consultant multi-entreprises, ou premier choix). */
export async function definirEntrepriseSession(
  trx: Transaction<DB>,
  params: { sessionId: string, entrepriseId: string },
): Promise<void> {
  await trx
    .updateTable('session')
    .set({ entreprise_id: params.entrepriseId })
    .where('id', '=', params.sessionId)
    .execute()
}

export async function revoquerSession(trx: Transaction<DB>, sessionId: string): Promise<void> {
  await trx
    .updateTable('session')
    .set({ revoque_le: new Date() })
    .where('id', '=', sessionId)
    .execute()
}

/** Révoque toutes les sessions d'un utilisateur — changement de mot de passe, compte suspecté compromis. */
export async function revoquerToutesLesSessions(trx: Transaction<DB>, utilisateurId: string): Promise<void> {
  await trx
    .updateTable('session')
    .set({ revoque_le: new Date() })
    .where('utilisateur_id', '=', utilisateurId)
    .where('revoque_le', 'is', null)
    .execute()
}

// ---------------------------------------------------------------------------
// Session partielle (2FA)
// ---------------------------------------------------------------------------

export interface SessionPartielle {
  sessionId: string
  utilisateurId: string
  /** 'code' : saisir le code ; 'activation' : activer la 2FA (rôle qui l'impose) ; null : session complète. */
  etape: 'code' | 'activation' | null
  tentatives: number
}

/** Session valide, complète OU en attente du deuxième facteur : réservée aux routes 2FA. */
export async function validerSessionPartielle(trx: Transaction<DB>, jeton: string): Promise<SessionPartielle | null> {
  const row = await trx.selectFrom('session')
    .select(['id', 'utilisateur_id', 'expire_le', 'revoque_le', 'a2f_requise', 'a2f_etape', 'a2f_validee_le', 'a2f_tentatives'])
    .where('jeton_hash', '=', hacherJeton(jeton)).executeTakeFirst()
  if (!row || row.revoque_le !== null || row.expire_le.getTime() < Date.now()) return null
  const partielle = row.a2f_requise && row.a2f_validee_le === null
  return { sessionId: row.id, utilisateurId: row.utilisateur_id, etape: partielle ? (row.a2f_etape === 'activation' ? 'activation' : 'code') : null, tentatives: row.a2f_tentatives }
}

/** Fixe l'étape d'une session partielle, ou la LIBÈRE (étape null : aucun deuxième facteur à demander). */
export async function definirEtapeA2f(trx: Transaction<DB>, sessionId: string, etape: 'code' | 'activation' | null): Promise<void> {
  await trx.updateTable('session')
    .set(etape ? { a2f_requise: true, a2f_etape: etape } : { a2f_requise: false, a2f_etape: null })
    .where('id', '=', sessionId).execute()
}

export async function validerA2fSession(trx: Transaction<DB>, sessionId: string): Promise<void> {
  await trx.updateTable('session').set({ a2f_validee_le: new Date(), a2f_etape: null }).where('id', '=', sessionId).execute()
}

/** Compte un échec de deuxième facteur ; à 5 échecs la session est révoquée (il faut ressaisir le mot de passe). */
export async function compterEchecA2f(trx: Transaction<DB>, sessionId: string): Promise<number> {
  const r = await trx.updateTable('session').set((eb) => ({ a2f_tentatives: eb('a2f_tentatives', '+', 1) })).where('id', '=', sessionId).returning('a2f_tentatives').executeTakeFirstOrThrow()
  if (r.a2f_tentatives >= 5) await revoquerSession(trx, sessionId)
  return r.a2f_tentatives
}
